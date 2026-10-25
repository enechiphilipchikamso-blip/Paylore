import { describe, expect, it, vi } from "vitest";
import type { Database } from "./client";
import { beginPayrollSettlementAttempt, listFinalizedLedgerWorkspaceIdsForSignature, recordVerifiedPayrollClaimFinalizationEvent, recordVerifiedPayrollClaimSettlement } from "./repositories";
function query(result: unknown) {
  const builder: Record<string, unknown> = {};
  for (const name of ["from", "innerJoin", "leftJoin", "where", "orderBy", "limit", "for"]) builder[name] = vi.fn(() => builder);
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
  return builder;
}
type Mutation = { method: string; value?: unknown };
function mutation(calls: Mutation[], method: string, returningRows: unknown[] = [{ id: "row-1" }]) {
  const builder: Record<string, unknown> = {};
  let result: unknown = [];
  builder.values = vi.fn((value: unknown) => { calls.push({ method, value }); return builder; });
  builder.set = vi.fn((value: unknown) => { calls.push({ method, value }); return builder; });
  builder.where = vi.fn(() => builder);
  builder.onConflictDoNothing = vi.fn(() => builder);
  builder.returning = vi.fn(() => { result = returningRows; return builder; });
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
  return builder;
}
function fakeDatabase(selects: unknown[][], insertResults: unknown[][] = []) {
  const mutations: Mutation[] = [];
  const tx = { select: vi.fn(() => query(selects.shift() ?? [])), update: vi.fn(() => mutation(mutations, "update")), insert: vi.fn(() => mutation(mutations, "insert", insertResults.shift() ?? [{ id: "row-1" }])) };
  const db = { transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)) };
  return { db: db as unknown as Database, tx, mutations };
}
const settlementSignature = "5".repeat(64);
const creationSignature = "6".repeat(64);
const common = {
  workspaceId: "workspace-a", runId: "run-a", allocationId: "allocation-a",
  contributorUserId: "contributor-user", claimAddress: "ClaimPdaAddress111111111111111111111111111111",
  claimCreationSignature: creationSignature, settlementSignature,
  sourceTokenAccount: "reserve-token", destinationTokenAccount: "contributor-token",
  mint: "wrapped-usdc-mint", programId: "payroll-program", authorityAddress: "manager-wallet",
  sourceAvailableBefore: "9000000", sourceAvailableAfter: "8000000", now: new Date("2026-10-24T11:23:00.000Z")
};
const pendingAllocation = {
  id: "allocation-a", amountBaseUnits: "1000000", claimId: "01".repeat(32),
  claimAddress: common.claimAddress, status: "settlement_pending",
  transactionSignature: creationSignature, settlementSignature,
  settlementSourceAvailableBefore: "9000000"
};
describe("confidential payroll settlement repository", () => {
  it("posts a ledger entry after the reserve debit equals the allocation", async () => {
    const db = fakeDatabase([[pendingAllocation], [{ userId: "finance-user" }], []]);
    await expect(recordVerifiedPayrollClaimSettlement(db.db, common)).resolves.toMatchObject({
      status: "claimed", amountBaseUnits: "1000000", settlementSignature
    });
    const inserts = db.mutations.filter(x => x.method === "insert").map(x => x.value);
    expect(inserts).toContainEqual(expect.objectContaining({
      idempotencyKey: "payroll-settlement:allocation-a", entryType: "confidential_claim_settlement",
      status: "finalized", amountBaseUnits: "1000000", transactionSignature: settlementSignature,
      metadata: expect.objectContaining({ balanceDeltaVerified: true, valueTransferred: true })
    }));
    const notifications = inserts.flatMap((value) => Array.isArray(value) ? value : [value])
      .filter((value): value is Record<string, unknown> => Boolean(value) &&
        typeof value === "object" && "eventKey" in value);
    expect(notifications).toContainEqual(expect.objectContaining({
      recipientKey: common.contributorUserId,
      eventKey: "payroll-settlement:allocation-a",
      title: "Confidential payroll claim settled"
    }));
    expect(notifications).toContainEqual(expect.objectContaining({
      recipientKey: "finance-user",
      eventKey: "payroll-settlement:allocation-a",
      title: "Confidential payroll settlement finalized"
    }));
  });
  it("rejects a balance delta different from the committed amount", async () => {
    const db = fakeDatabase([[pendingAllocation]]);
    await expect(recordVerifiedPayrollClaimSettlement(db.db, { ...common, sourceAvailableAfter: "7999999" }))
      .resolves.toEqual({ status: "balance_mismatch" });
    expect(db.tx.update).not.toHaveBeenCalled();
    expect(db.tx.insert).not.toHaveBeenCalled();
  });
  it("does not start over when a matching settlement is already pending", async () => {
    const db = fakeDatabase([
      [{ workspaceId: common.workspaceId }],
      [{ ...pendingAllocation, settlementSignature: null }]
    ]);
    await expect(beginPayrollSettlementAttempt(db.db, {
      workspaceId: common.workspaceId, runId: common.runId, allocationId: common.allocationId,
      claimAddress: common.claimAddress, claimCreationSignature: creationSignature,
      sourceAvailableBefore: "9000000"
    })).resolves.toEqual({ status: "pending", signature: null });
    expect(db.tx.update).not.toHaveBeenCalled();
  });

  it("serializes different allocations against the same reserve", async () => {
    const db = fakeDatabase([
      [{ workspaceId: common.workspaceId }],
      [{
        id: "allocation-b", claimAddress: "claim-b", status: "unclaimed",
        transactionSignature: creationSignature, settlementSignature: null,
        settlementSourceAvailableBefore: null
      }],
      [{ id: "allocation-a" }]
    ]);
    await expect(beginPayrollSettlementAttempt(db.db, {
      workspaceId: common.workspaceId, runId: common.runId, allocationId: "allocation-b",
      claimAddress: "claim-b", claimCreationSignature: creationSignature,
      sourceAvailableBefore: "9000000"
    })).resolves.toEqual({ status: "workspace_busy" });
    expect(db.tx.update).not.toHaveBeenCalled();
  });
});


describe("finalized Claim PDA event reconciliation", () => {
  const claimedAllocation = {
    id: common.allocationId, workspaceId: common.workspaceId, payrollRunId: common.runId,
    status: "claimed", claimAddress: common.claimAddress, contributorUserId: "contributor-user",
    transactionSignature: common.claimCreationSignature, settlementSignature: common.settlementSignature
  };
  const finalizationInput = {
    workspaceId: common.workspaceId, runId: common.runId, allocationId: common.allocationId,
    claimAddress: common.claimAddress, claimCreationSignature: common.claimCreationSignature,
    settlementSignature: common.settlementSignature, authorityAddress: "reserve-authority",
    signature: "7".repeat(64)
  };

  it("records a zero-amount state-transition entry only after the settlement ledger is finalized", async () => {
    const db = fakeDatabase([
      [claimedAllocation],
      [{ status: "finalized", transactionSignature: common.settlementSignature }],
      [{ userId: "finance-user" }]
    ]);
    await expect(recordVerifiedPayrollClaimFinalizationEvent(db.db, finalizationInput))
      .resolves.toEqual({ status: "finalized" });
    const writes = db.mutations.filter((entry) => entry.method === "insert").map((entry) => entry.value);
    expect(writes).toContainEqual(expect.objectContaining({
      workspaceId: common.workspaceId,
      idempotencyKey: "payroll-claim-finalization:allocation-a",
      entryType: "claim_finalized",
      status: "finalized",
      amountBaseUnits: null,
      transactionSignature: "7".repeat(64),
      metadata: expect.objectContaining({
        settlementSignature: common.settlementSignature,
        valueTransferred: false
      })
    }));
    const notifications = writes.flatMap((value) => Array.isArray(value) ? value : [value])
      .filter((value): value is Record<string, unknown> => Boolean(value) &&
        typeof value === "object" && "eventKey" in value);
    expect(notifications).toContainEqual(expect.objectContaining({
      recipientKey: "contributor-user",
      eventKey: "payroll-claim-finalization:allocation-a",
      title: "Payroll claim finalized",
      destination: "/workspace/workspace-a/compensation"
    }));
    expect(notifications).toContainEqual(expect.objectContaining({
      recipientKey: "finance-user",
      eventKey: "payroll-claim-finalization:allocation-a",
      title: "Payroll claim finalization verified",
      destination: "/workspace/workspace-a/ledger"
    }));
  });

  it("does not record claim finalization before the exact settlement ledger exists", async () => {
    const db = fakeDatabase([[claimedAllocation], []]);
    await expect(recordVerifiedPayrollClaimFinalizationEvent(db.db, finalizationInput))
      .resolves.toEqual({ status: "not_reconciled" });
    expect(db.tx.update).not.toHaveBeenCalled();
    expect(db.mutations.filter((entry) => entry.method === "insert")).toHaveLength(0);
  });

  it("treats only the same finalization transaction as an idempotent replay", async () => {
    const db = fakeDatabase([
      [claimedAllocation],
      [{ status: "finalized", transactionSignature: common.settlementSignature }],
      [{ status: "finalized", transactionSignature: finalizationInput.signature }],
      [{ userId: "finance-user" }]
    ], [[]]);
    await expect(recordVerifiedPayrollClaimFinalizationEvent(db.db, finalizationInput))
      .resolves.toEqual({ status: "duplicate" });
    const notifications = db.mutations.filter((entry) => entry.method === "insert").map((entry) => entry.value)
      .flatMap((value) => Array.isArray(value) ? value : [value])
      .filter((value): value is Record<string, unknown> => Boolean(value) &&
        typeof value === "object" && "eventKey" in value);
    expect(notifications).toContainEqual(expect.objectContaining({
      recipientKey: "contributor-user",
      eventKey: "payroll-claim-finalization:allocation-a"
    }));
    expect(notifications).toContainEqual(expect.objectContaining({
      recipientKey: "finance-user",
      eventKey: "payroll-claim-finalization:allocation-a"
    }));
  });

  it("lists finalized ledger workspaces for a transaction signature", async () => {
    const rows = [{ workspaceId: common.workspaceId }];
    const selectDistinct = vi.fn(() => query(rows));
    const db = { selectDistinct } as unknown as Database;
    await expect(listFinalizedLedgerWorkspaceIdsForSignature(db, common.settlementSignature)).resolves.toEqual(rows);
    expect(selectDistinct).toHaveBeenCalledTimes(1);
  });
});
