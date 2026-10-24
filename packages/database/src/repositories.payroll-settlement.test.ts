import { describe, expect, it, vi } from "vitest";
import type { Database } from "./client";
import { beginPayrollSettlementAttempt, recordVerifiedPayrollClaimSettlement } from "./repositories";
function query(result: unknown) {
  const builder: Record<string, unknown> = {};
  for (const name of ["from", "innerJoin", "where", "orderBy", "limit", "for"]) builder[name] = vi.fn(() => builder);
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
  return builder;
}
type Mutation = { method: string; value?: unknown };
function mutation(calls: Mutation[], method: string) {
  const builder: Record<string, unknown> = {};
  let result: unknown = [];
  builder.values = vi.fn((value: unknown) => { calls.push({ method, value }); return builder; });
  builder.set = vi.fn((value: unknown) => { calls.push({ method, value }); return builder; });
  builder.where = vi.fn(() => builder);
  builder.onConflictDoNothing = vi.fn(() => builder);
  builder.returning = vi.fn(() => { result = [{ id: "row-1" }]; return builder; });
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
  return builder;
}
function fakeDatabase(selects: unknown[][]) {
  const mutations: Mutation[] = [];
  const tx = { select: vi.fn(() => query(selects.shift() ?? [])), update: vi.fn(() => mutation(mutations, "update")), insert: vi.fn(() => mutation(mutations, "insert")) };
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
    const db = fakeDatabase([[pendingAllocation], [], [{ userId: "finance-user" }]]);
    await expect(recordVerifiedPayrollClaimSettlement(db.db, common)).resolves.toMatchObject({
      status: "claimed", amountBaseUnits: "1000000", settlementSignature
    });
    const inserts = db.mutations.filter(x => x.method === "insert").map(x => x.value);
    expect(inserts).toContainEqual(expect.objectContaining({
      idempotencyKey: "payroll-settlement:allocation-a", entryType: "confidential_claim_settlement",
      status: "finalized", amountBaseUnits: "1000000", transactionSignature: settlementSignature,
      metadata: expect.objectContaining({ balanceDeltaVerified: true, valueTransferred: true })
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
    const db = fakeDatabase([[{ ...pendingAllocation, settlementSignature: null }]]);
    await expect(beginPayrollSettlementAttempt(db.db, {
      workspaceId: common.workspaceId, runId: common.runId, allocationId: common.allocationId,
      claimAddress: common.claimAddress, claimCreationSignature: creationSignature,
      sourceAvailableBefore: "9000000"
    })).resolves.toEqual({ status: "pending", signature: null });
    expect(db.tx.update).not.toHaveBeenCalled();
  });
});
