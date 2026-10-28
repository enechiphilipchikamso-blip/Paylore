import { describe, expect, it, vi } from "vitest";
import type { Database } from "./client";
import {
  recordVerifiedPublicCashOutLedger,
  recordWorkspaceNonFinancialOutcome
} from "./repositories";

type Mutation = { method: string; value?: unknown };
function query(result: unknown) {
  const builder: Record<string, any> = {};
  for (const name of ["from", "innerJoin", "where", "orderBy", "limit", "for"]) {
    builder[name] = vi.fn(() => builder);
  }
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}
function mutation(
  calls: Mutation[],
  returningRows: unknown[] = [{ id: "entry-1" }]
) {
  const builder: Record<string, any> = {};
  let result: unknown = [];
  builder.values = vi.fn((value: unknown) => { calls.push({ method: "values", value }); return builder; });
  builder.onConflictDoNothing = vi.fn(() => builder);
  builder.returning = vi.fn(() => { result = returningRows; return builder; });
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}
function fakeDatabase(
  selects: unknown[][],
  insertResults: unknown[][] = []
) {
  const writes: Mutation[] = [];
  const tx = {
    select: vi.fn(() => query(selects.shift() ?? [])),
    insert: vi.fn(() => mutation(writes, insertResults.shift() ?? [{ id: "entry-1" }]))
  };
  const db = {
    transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx))
  };
  return { db: db as unknown as Database, tx, writes };
}

const now = new Date("2026-10-25T16:00:00.000Z");
const cashOut = {
  workspaceId: "workspace-a",
  contributorId: "contributor-a",
  contributorWalletAddress: "Wallet1111111111111111111111111111111111",
  kind: "confidential_withdrawal" as const,
  signature: "5".repeat(88),
  amountBaseUnits: "1250000",
  mint: "wrapped-usdc-mint",
  sourceTokenAccount: "contributor-confidential-account",
  destinationTokenAccount: "contributor-confidential-account",
  now
};

describe("non-financial workspace ledger outcomes", () => {
  it("writes no amount or mint for pending/conflict/failure outcome records", async () => {
    const fake = fakeDatabase([], [[{ id: "entry-1" }]]);
    await expect(recordWorkspaceNonFinancialOutcome(fake.db, {
      workspaceId: "workspace-a",
      idempotencyKey: "payroll-settlement-outcome:allocation-a:pending:AbCd123",
      category: "payroll",
      entryType: "claim_settlement_pending",
      status: "pending",
      referenceType: "payroll_allocation",
      referenceId: "allocation-a",
      metadata: { runId: "run-a", outcome: "pending" },
      now
    })).resolves.toEqual({ status: "recorded" });

    const inserted = fake.writes.find((entry) => entry.method === "values")?.value as Record<string, unknown>;
    expect(inserted).toMatchObject({
      idempotencyKey: "payroll-settlement-outcome:allocation-a:pending:AbCd123",
      entryType: "claim_settlement_pending",
      status: "pending",
      amountBaseUnits: null,
      mint: null,
      metadata: {
        runId: "run-a",
        outcome: "pending",
        financialValueVerified: false,
        amountOmittedReason: "non_financial_outcome"
      }
    });
    expect(inserted).not.toHaveProperty("amountBaseUnits", "1250000");
  });

  it("rejects metadata that could accidentally include ciphertext or confidential amounts", async () => {
    const fake = fakeDatabase([]);
    await expect(recordWorkspaceNonFinancialOutcome(fake.db, {
      workspaceId: "workspace-a",
      idempotencyKey: "payroll-outcome:one",
      category: "payroll",
      entryType: "claim_settlement_failed",
      status: "failed",
      metadata: { outcome: "failed", confidentialCiphertext: "opaque" },
      now
    })).rejects.toThrow("The non-financial ledger outcome is invalid.");
    expect(fake.tx.insert).not.toHaveBeenCalled();
  });

  it("treats a matching idempotency replay as duplicate and changed outcome as conflict", async () => {
    const matchingRow = {
      category: "payroll",
      entryType: "claim_settlement_failed",
      status: "failed",
      referenceType: "payroll_allocation",
      referenceId: "allocation-a",
      transactionSignature: "signature-a",
      metadata: { outcome: "state_conflict", errorCode: "claim_state_conflict" }
    };
    const same = fakeDatabase([ [matchingRow] ], [[]]);
    await expect(recordWorkspaceNonFinancialOutcome(same.db, {
      workspaceId: "workspace-a",
      idempotencyKey: "claim-outcome:allocation-a",
      category: "payroll",
      entryType: "claim_settlement_failed",
      status: "failed",
      referenceType: "payroll_allocation",
      referenceId: "allocation-a",
      transactionSignature: "signature-a",
      metadata: { outcome: "state_conflict", errorCode: "claim_state_conflict" },
      now
    })).resolves.toEqual({ status: "duplicate" });

    const changed = fakeDatabase([ [matchingRow] ], [[]]);
    await expect(recordWorkspaceNonFinancialOutcome(changed.db, {
      workspaceId: "workspace-a",
      idempotencyKey: "claim-outcome:allocation-a",
      category: "payroll",
      entryType: "claim_settlement_failed",
      status: "failed",
      referenceType: "payroll_allocation",
      referenceId: "allocation-a",
      transactionSignature: "signature-a",
      metadata: { outcome: "failed", errorCode: "reserve_failed" },
      now
    })).resolves.toEqual({ status: "conflict" });
  });
});

describe("verified public cash-out ledger entries", () => {
  it("records an exact server-verified withdrawal amount and destination", async () => {
    const fake = fakeDatabase(
      [
        [{
          id: "contributor-a",
          identityWalletAddress: cashOut.contributorWalletAddress,
          lifecycle: "active"
        }],
        [{ userId: "contributor-user" }],
        [{ userId: "finance-user" }]
      ],
      [[{ id: "entry-1" }]]
    );
    await expect(recordVerifiedPublicCashOutLedger(fake.db, cashOut)).resolves.toEqual({ status: "finalized" });

    const values = fake.writes.filter((write) => write.method === "values").map((write) => write.value);
    const entry = values.find((value) => !Array.isArray(value) && value &&
      typeof value === "object" && "idempotencyKey" in value) as Record<string, unknown>;
    expect(entry).toMatchObject({
      category: "cash_out",
      entryType: "confidential_balance_withdrawal",
      status: "finalized",
      amountBaseUnits: "1250000",
      mint: "wrapped-usdc-mint",
      referenceType: "contributor",
      referenceId: "contributor-a",
      transactionSignature: cashOut.signature,
      metadata: {
        contributorWalletAddress: cashOut.contributorWalletAddress,
        sourceTokenAccount: cashOut.sourceTokenAccount,
        destinationTokenAccount: cashOut.destinationTokenAccount,
        balanceDeltaVerified: true,
        valueTransferred: true
      }
    });
    const notifications = values.flatMap((value) => Array.isArray(value) ? value : [value])
      .filter((value): value is Record<string, unknown> => Boolean(value) &&
        typeof value === "object" && "eventKey" in value);
    expect(notifications).toContainEqual(expect.objectContaining({
      recipientKey: "contributor-user",
      eventKey: `public-cash-out:confidential_withdrawal:${cashOut.signature}`,
      title: "Token withdrawal finalized"
    }));
    expect(notifications).toContainEqual(expect.objectContaining({
      recipientKey: "finance-user",
      eventKey: `public-cash-out:confidential_withdrawal:${cashOut.signature}`,
      title: "Contributor token withdrawal finalized"
    }));
  });

  it("records a Token Wrap unwrap as Circle USDC only after the server-verified credit", async () => {
    const fake = fakeDatabase(
      [[{
        id: "contributor-a",
        identityWalletAddress: cashOut.contributorWalletAddress,
        lifecycle: "active"
      }]],
      [[{ id: "entry-1" }]]
    );
    await expect(recordVerifiedPublicCashOutLedger(fake.db, {
      ...cashOut,
      kind: "circle_usdc_unwrap",
      mint: "circle-usdc-mint",
      sourceTokenAccount: "public-wrapped-usdc-ata",
      destinationTokenAccount: "public-circle-usdc-ata"
    })).resolves.toEqual({ status: "finalized" });
    expect(fake.writes.map((write) => write.value)).toContainEqual(expect.objectContaining({
      category: "cash_out",
      entryType: "circle_usdc_unwrap",
      amountBaseUnits: cashOut.amountBaseUnits,
      mint: "circle-usdc-mint",
      metadata: expect.objectContaining({
        sourceTokenAccount: "public-wrapped-usdc-ata",
        destinationTokenAccount: "public-circle-usdc-ata",
        valueTransferred: true
      })
    }));
  });

  it("does not record a cash-out for a wallet other than the contributor's identity wallet", async () => {
    const fake = fakeDatabase([ [{
      id: "contributor-a",
      identityWalletAddress: "AnotherWallet1111111111111111111111111",
      lifecycle: "active"
    }] ]);
    await expect(recordVerifiedPublicCashOutLedger(fake.db, cashOut)).resolves.toEqual({ status: "not_found" });
    expect(fake.tx.insert).not.toHaveBeenCalled();
  });

  it("accepts only an exact idempotent replay of verified cash-out evidence", async () => {
    const existing = {
      entryType: "confidential_balance_withdrawal",
      status: "finalized",
      amountBaseUnits: cashOut.amountBaseUnits,
      mint: cashOut.mint,
      referenceType: "contributor",
      referenceId: cashOut.contributorId,
      transactionSignature: cashOut.signature,
      metadata: {
        contributorWalletAddress: cashOut.contributorWalletAddress,
        sourceTokenAccount: cashOut.sourceTokenAccount,
        destinationTokenAccount: cashOut.destinationTokenAccount,
        balanceDeltaVerified: true,
        valueTransferred: true
      }
    };
    const fake = fakeDatabase([
      [{
        id: "contributor-a",
        identityWalletAddress: cashOut.contributorWalletAddress,
        lifecycle: "active"
      }],
      [existing],
      [{ userId: "contributor-user" }],
      [{ userId: "finance-user" }]
    ], [[]]);
    await expect(recordVerifiedPublicCashOutLedger(fake.db, cashOut)).resolves.toEqual({ status: "duplicate" });
    const noticeRows = fake.writes.flatMap((write) => Array.isArray(write.value) ? write.value : [write.value])
      .filter((value): value is Record<string, unknown> => Boolean(value) &&
        typeof value === "object" && "eventKey" in value);
    expect(noticeRows).toContainEqual(expect.objectContaining({
      recipientKey: "contributor-user",
      eventKey: `public-cash-out:confidential_withdrawal:${cashOut.signature}`,
      title: "Token withdrawal finalized"
    }));
    expect(noticeRows).toContainEqual(expect.objectContaining({
      recipientKey: "finance-user",
      eventKey: `public-cash-out:confidential_withdrawal:${cashOut.signature}`,
      title: "Contributor token withdrawal finalized"
    }));
  });

  it("rejects malformed and out-of-range public amounts before touching the database", async () => {
    const fake = fakeDatabase([]);
    await expect(recordVerifiedPublicCashOutLedger(fake.db, {
      ...cashOut, amountBaseUnits: "01"
    })).rejects.toThrow("The verified public cash-out ledger input is invalid.");
    await expect(recordVerifiedPublicCashOutLedger(fake.db, {
      ...cashOut, amountBaseUnits: (1n << 64n).toString()
    })).rejects.toThrow("The verified public cash-out ledger input is invalid.");
    expect(fake.tx.select).not.toHaveBeenCalled();
  });
});
