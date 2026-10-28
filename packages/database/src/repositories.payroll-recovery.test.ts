import { describe, expect, it, vi } from "vitest";
import type { Database } from "./client";
import { listWorkspacePayrollRecoveryQueue, recordPayrollRecovery } from "./repositories";

function query(result: unknown) {
  const builder: Record<string, any> = {};
  for (const method of ["from", "innerJoin", "leftJoin", "where", "orderBy", "limit", "for"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

type Mutation = { method: string; value?: unknown };
function mutation(calls: Mutation[], method: string) {
  const builder: Record<string, any> = {};
  let result: unknown = [];
  builder.values = vi.fn((value: unknown) => { calls.push({ method, value }); return builder; });
  builder.set = vi.fn((value: unknown) => { calls.push({ method, value }); return builder; });
  builder.where = vi.fn(() => builder);
  builder.onConflictDoNothing = vi.fn(() => builder);
  builder.returning = vi.fn(() => { result = [{ id: "row-1" }]; return builder; });
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}
function fakeDatabase(selects: unknown[][]) {
  const mutations: Mutation[] = [];
  const tx = {
    select: vi.fn(() => query(selects.shift() ?? [])),
    update: vi.fn(() => mutation(mutations, "update")),
    insert: vi.fn(() => mutation(mutations, "insert"))
  };
  const db = {
    transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx))
  };
  return { db: db as unknown as Database, tx, mutations };
}

describe("workspace payroll recovery queue query", () => {
  it("joins contributor, run, and escrow state and bounds results to the requested workspace", async () => {
    const rows = [{
      allocationId: "allocation-a",
      runId: "run-a",
      contributorId: "contributor-a",
      contributorName: "Contributor A",
      contributorWalletAddress: "wallet-a",
      amountBaseUnits: "1250000",
      claimState: "unclaimed",
      claimAddress: "claim-a",
      escrowStatus: "funded"
    }];
    const builder = query(rows);
    const db = { select: vi.fn(() => builder) } as unknown as Database;

    await expect(listWorkspacePayrollRecoveryQueue(db, "workspace-a")).resolves.toEqual(rows);
    expect(builder.innerJoin).toHaveBeenCalledTimes(2);
    expect(builder.leftJoin).toHaveBeenCalledTimes(1);
    expect(builder.where).toHaveBeenCalledTimes(1);
    expect(builder.orderBy).toHaveBeenCalledTimes(1);
    expect(builder.limit).not.toHaveBeenCalled();
  });
});

describe("payroll recovery durable reconciliation", () => {
  const common = {
    workspaceId: "workspace-a",
    runId: "run-a",
    allocationId: "allocation-a",
    actorUserId: "admin-a",
    reason: "payroll_correction",
    reasonNote: null,
    signature: "5".repeat(64),
    claimAddress: "claim-a",
    sourceAvailableBefore: "2000",
    sourceAvailableAfter: "750",
    reserveAvailableBefore: "5000",
    reserveAvailableAfter: "6250",
    now: new Date("2026-10-25T08:00:00.000Z")
  };
  const allocation = {
    id: "allocation-a",
    contributorId: "contributor-a",
    contributorWalletAddress: "wallet-a",
    amountBaseUnits: "1250",
    claimId: "11".repeat(32),
    claimAddress: "claim-a",
    status: "recovery_pending",
    transactionSignature: "creation-signature"
  };
  const escrow = {
    allocationId: "allocation-a",
    workspaceId: "workspace-a",
    payrollRunId: "run-a",
    tokenAccountAddress: "escrow-a",
    status: "recovery_pending",
    recoverySignature: "5".repeat(64)
  };
  const selects = () => [
    [allocation],
    [escrow],
    [],
    [{ userId: "contributor-user" }],
    [{ userId: "finance-user" }]
  ];

  it("records a recovery ledger entry and notices only for exact confirmed source debit and reserve credit", async () => {
    const db = fakeDatabase(selects());
    await expect(recordPayrollRecovery(db.db, common)).resolves.toEqual({ status: "recovered" });
    const writes = db.mutations.filter((item) => item.method === "insert").map((item) => item.value);
    expect(writes).toContainEqual(expect.objectContaining({
      idempotencyKey: "payroll-recovery:allocation-a",
      category: "recovery",
      entryType: "confidential_claim_recovery",
      status: "finalized",
      transactionSignature: common.signature,
      metadata: expect.objectContaining({
        balanceDeltaVerified: true,
        valueTransferred: true,
        restoredReserveBaseUnits: "1250"
      })
    }));
    expect(writes.some((value) => Array.isArray(value) &&
      value.some((item) => item.eventKey === "payroll-recovery:allocation-a" &&
        item.category === "Recovery & Offboarding" &&
        item.title === "Unclaimed payroll restored to the reserve"))).toBe(true);
    expect(writes.some((value) => Array.isArray(value) &&
      value.some((item) => item.eventKey === "payroll-recovery:allocation-a" &&
        item.title === "Confidential payroll recovery finalized"))).toBe(true);
  });

  it("does not update the recovery state, ledger, or notifications on an amount mismatch", async () => {
    const db = fakeDatabase([[allocation], [escrow]]);
    await expect(recordPayrollRecovery(db.db, {
      ...common,
      sourceAvailableAfter: "751"
    })).resolves.toEqual({ status: "balance_mismatch" });
    expect(db.tx.update).not.toHaveBeenCalled();
    expect(db.tx.insert).not.toHaveBeenCalled();
  });
  it("refuses recovery after claim settlement has reserved the allocation", async () => {
    const db = fakeDatabase([[{ ...allocation, status: "settlement_pending" }], [{ ...escrow, status: "settlement_pending" }], []]);
    await expect(recordPayrollRecovery(db.db, common)).resolves.toEqual({ status: "conflict" });
    expect(db.tx.update).not.toHaveBeenCalled();
    expect(db.tx.insert).not.toHaveBeenCalled();
  });

});
