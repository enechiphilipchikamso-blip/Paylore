import { describe, expect, it, vi } from "vitest";
import type { Database } from "./client";
import { recordPayrollClaimSubmission } from "./repositories";

type MutationRecord = { method: string; value: unknown };

function query(result: unknown) {
  const builder: Record<string, unknown> = {};
  for (const method of ["from", "innerJoin", "where", "orderBy", "limit", "for"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

function mutation(calls: MutationRecord[], method: string, result: unknown = []) {
  const builder: Record<string, unknown> = {};
  builder.values = vi.fn((value: unknown) => {
    calls.push({ method, value });
    return builder;
  });
  builder.set = vi.fn((value: unknown) => {
    calls.push({ method, value });
    return builder;
  });
  builder.where = vi.fn(() => builder);
  builder.onConflictDoNothing = vi.fn(() => builder);
  builder.returning = vi.fn(() => builder);
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

function fakeDatabase(selectResults: unknown[][]) {
  const mutations: MutationRecord[] = [];
  const tx = {
    select: vi.fn(() => query(selectResults.shift() ?? [])),
    update: vi.fn(() => mutation(mutations, "update")),
    insert: vi.fn(() => mutation(mutations, "insert"))
  };
  const db = {
    transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx))
  };
  return { db: db as unknown as Database, tx, mutations };
}

const claimId = "01".repeat(32);
const claimAddress = "ClaimPdaAddress111111111111111111111111111111";
const signature = "5".repeat(64);
const input = {
  workspaceId: "workspace-a",
  runId: "run-a",
  signature,
  programId: "payroll-program",
  authorityAddress: "manager-wallet",
  claims: [{ claimId, claimAddress, escrowTokenAccount: "escrow-token-account" }],
  now: new Date("2026-10-24T09:00:00.000Z")
};

function selectResults(allocation: Record<string, unknown>, runStatus = "committed") {
  return [
    [{ id: "run-a", status: runStatus, allocationCommitment: "ab".repeat(32) }],
    [allocation],
    [{
      allocationId: allocation.id,
      payrollRunId: "run-a",
      claimId,
      tokenAccountAddress: "escrow-token-account",
      status: "funded"
    }],
    [{ claimAddress }],
    [{ userId: "finance-user" }]
  ];
}

describe("payroll Claim-PDA submission durability", () => {
  it("writes one evidence-rich ledger entry and finance notice for a finalized PDA batch", async () => {
    const database = fakeDatabase(selectResults({
      id: "allocation-a",
      claimId,
      claimAddress: null,
      status: "draft",
      transactionSignature: null
    }, "commit_pending"));

    await expect(recordPayrollClaimSubmission(database.db, input)).resolves.toEqual({
      status: "committed",
      submittedCount: 1,
      totalCount: 1
    });

    const inserts = database.mutations
      .filter((entry) => entry.method === "insert")
      .map((entry) => entry.value as Record<string, unknown>);
    const ledger = inserts.find((value) => value.idempotencyKey === `payroll-claim-commit:run-a:${signature}`);
    expect(ledger).toMatchObject({
      workspaceId: "workspace-a",
      category: "payroll",
      entryType: "claim_commitment",
      status: "finalized",
      referenceType: "payroll_run",
      referenceId: "run-a",
      transactionSignature: signature,
      metadata: {
        claimIds: [claimId],
        claims: [{ claimId, claimAddress }],
        allocationCommitment: "ab".repeat(32),
        programId: "payroll-program",
        authorityAddress: "manager-wallet",
        evidenceSource: "finalized_chain_verification"
      }
    });
    const notices = inserts.find((value) => Array.isArray(value));
    expect(notices).toEqual(expect.arrayContaining([
      expect.objectContaining({
        eventKey: `payroll-claim-commit:run-a:${signature}`,
        category: "Payroll & Claims"
      })
    ]));
  });

  it("does not overwrite the original finalized creation signature on a different retry", async () => {
    const database = fakeDatabase([
      [{ id: "run-a", status: "committed", allocationCommitment: "ab".repeat(32) }],
      [{
        id: "allocation-a",
        claimId,
        claimAddress,
        status: "unclaimed",
        transactionSignature: "6".repeat(64)
      }],
      [{
        allocationId: "allocation-a",
        payrollRunId: "run-a",
        claimId,
        tokenAccountAddress: "escrow-token-account",
        status: "funded"
      }]
    ]);

    await expect(recordPayrollClaimSubmission(database.db, input)).resolves.toEqual({
      status: "claim_conflict"
    });
    expect(database.tx.update).not.toHaveBeenCalled();
    expect(database.tx.insert).not.toHaveBeenCalled();
  });

  it("recognizes the same finalized batch after the run reaches a terminal state", async () => {
    const database = fakeDatabase([
      [{ id: "run-a", status: "complete", allocationCommitment: "ab".repeat(32) }],
      [{
        id: "allocation-a",
        claimId,
        claimAddress,
        status: "claimed",
        transactionSignature: "settlement-signature"
      }],
      [{
        allocationId: "allocation-a",
        payrollRunId: "run-a",
        claimId,
        tokenAccountAddress: "escrow-token-account",
        status: "funded"
      }],
      [{
        metadata: {
          programId: "payroll-program",
          authorityAddress: "manager-wallet",
          allocationCommitment: "ab".repeat(32),
          claims: [{ claimId, claimAddress, escrowTokenAccount: "escrow-token-account" }]
        }
      }]
    ]);

    await expect(recordPayrollClaimSubmission(database.db, input)).resolves.toEqual({
      status: "duplicate",
      submittedCount: 1,
      totalCount: 1
    });
    expect(database.tx.update).not.toHaveBeenCalled();
    expect(database.tx.insert).not.toHaveBeenCalled();
  });

  it("does not classify terminal state as a replay when original ledger evidence does not match", async () => {
    const database = fakeDatabase([
      [{ id: "run-a", status: "complete", allocationCommitment: "ab".repeat(32) }],
      [{
        id: "allocation-a",
        claimId,
        claimAddress,
        status: "recovered",
        transactionSignature: "recovery-signature"
      }],
      [{
        allocationId: "allocation-a",
        payrollRunId: "run-a",
        claimId,
        tokenAccountAddress: "escrow-token-account",
        status: "funded"
      }],
      [{
        metadata: {
          programId: "other-program",
          authorityAddress: "manager-wallet",
          allocationCommitment: "ab".repeat(32),
          claims: [{ claimId, claimAddress, escrowTokenAccount: "escrow-token-account" }]
        }
      }]
    ]);

    await expect(recordPayrollClaimSubmission(database.db, input)).resolves.toEqual({
      status: "claim_conflict"
    });
    expect(database.tx.update).not.toHaveBeenCalled();
    expect(database.tx.insert).not.toHaveBeenCalled();
  });
});
