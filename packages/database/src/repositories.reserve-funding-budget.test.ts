import { describe, expect, it, vi } from "vitest";
import type { Database } from "./client";
import {
  advanceWorkspaceReserveFundingOperation,
  reserveWorkspaceReserveFundingFeeBudget
} from "./repositories";
import { gasTankOperations, workspaceGasTanks } from "./schema";

type SelectCall = { table?: unknown; lock?: string };
type UpdateCall = { table?: unknown; value?: unknown };

function query(result: unknown, calls?: SelectCall[]) {
  const builder: Record<string, any> = {};
  builder.from = vi.fn((table: unknown) => {
    if (calls) {
      const current = calls[calls.length - 1];
      if (current) current.table = table;
    }
    return builder;
  });
  builder.where = vi.fn(() => builder);
  builder.for = vi.fn((lock: string) => {
    if (calls) {
      const current = calls[calls.length - 1];
      if (current) current.lock = lock;
    }
    return builder;
  });
  builder.limit = vi.fn(() => builder);
  builder.then = (
    resolve: (value: unknown) => unknown,
    reject?: (reason: unknown) => unknown
  ) => Promise.resolve(result).then(resolve, reject);
  return builder;
}

function mutation(calls: UpdateCall[], table: unknown) {
  const builder: Record<string, any> = {};
  builder.set = vi.fn((value: unknown) => {
    calls.push({ table, value });
    return builder;
  });
  builder.where = vi.fn(() => builder);
  builder.returning = vi.fn(async () => [{ id: "reserve-operation" }]);
  return builder;
}

function fakeDatabase(selectResults: unknown[][]) {
  const selectCalls: SelectCall[] = [];
  const updateCalls: UpdateCall[] = [];
  const tx = {
    select: vi.fn(() => {
      selectCalls.push({});
      return query(selectResults.shift() ?? [], selectCalls);
    }),
    update: vi.fn((table: unknown) => mutation(updateCalls, table))
  };
  const db = {
    transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx))
  };
  return {
    db: db as unknown as Database,
    tx,
    selectCalls,
    updateCalls
  };
}

const since = new Date("2026-10-30T00:00:00.000Z");
const operation = {
  id: "reserve-operation",
  workspaceId: "workspace-a",
  operationType: "reserve_ordinary_usdc_confidential_funding",
  status: "preparing",
  feeLamports: "0",
  failureCode: null,
  operationData: {
    stage: "wrap_verified",
    walletAddress: "administrator-wallet"
  }
};

const reservationInput = {
  workspaceId: "workspace-a",
  operationId: "reserve-operation",
  reservationKeys: ["preapply:1", "deposit:1", "apply:1"],
  feePerTransactionLamports: "100000",
  availableBalanceLamports: "1000000",
  maxDailyFeeLamports: "5000000",
  maxDailyOperations: 100,
  since
};

describe("workspace Reserve Gas Tank fee reservations", () => {
  it("locks the shared Gas Tank row before reserving all private Reserve phases", async () => {
    const fake = fakeDatabase([
      [{ workspaceId: "workspace-a" }],
      [operation],
      [
        {
          id: "other-sponsor",
          status: "preparing",
          feeLamports: "100000",
          failureCode: null,
          operationData: { reservedRentLamports: "20000" }
        }
      ]
    ]);

    await expect(reserveWorkspaceReserveFundingFeeBudget(fake.db, reservationInput))
      .resolves.toBe("reserved");

    expect(fake.selectCalls[0]?.table).toBe(workspaceGasTanks);
    expect(fake.selectCalls[0]?.lock).toBe("update");
    expect(fake.selectCalls[1]?.table).toBe(gasTankOperations);
    expect(fake.selectCalls[1]?.lock).toBe("update");
    expect(fake.updateCalls).toHaveLength(1);
    expect(fake.updateCalls[0]?.table).toBe(gasTankOperations);
    expect(fake.updateCalls[0]?.value).toMatchObject({
      feeLamports: "300000",
      operationData: {
        feeBudgetReserved: true,
        actualFeeLamports: "0",
        feeReservationKeys: ["preapply:1", "deposit:1", "apply:1"]
      }
    });
  });

  it("treats a replay of the same reservation keys as an idempotent duplicate", async () => {
    const existing = {
      ...operation,
      feeLamports: "300000",
      operationData: {
        ...operation.operationData,
        feeBudgetReserved: true,
        actualFeeLamports: "0",
        feeReservationKeys: ["preapply:1", "deposit:1", "apply:1"]
      }
    };
    const fake = fakeDatabase([
      [{ workspaceId: "workspace-a" }],
      [existing]
    ]);

    await expect(reserveWorkspaceReserveFundingFeeBudget(fake.db, reservationInput))
      .resolves.toBe("duplicate");
    expect(fake.selectCalls).toHaveLength(2);
    expect(fake.updateCalls).toHaveLength(0);
  });

  it("refuses a reservation when the live balance cannot cover other sponsors and reserved rent", async () => {
    const fake = fakeDatabase([
      [{ workspaceId: "workspace-a" }],
      [operation],
      [{
        id: "other-sponsor",
        status: "preparing",
        feeLamports: "250000",
        failureCode: null,
        operationData: { reservedRentLamports: "100000" }
      }]
    ]);

    await expect(reserveWorkspaceReserveFundingFeeBudget(fake.db, {
      ...reservationInput,
      availableBalanceLamports: "600000"
    })).resolves.toBe("insufficient_balance");
    expect(fake.updateCalls).toHaveLength(0);
  });

  it("enforces the daily transaction count and fee ceiling before writing a reservation", async () => {
    const fake = fakeDatabase([
      [{ workspaceId: "workspace-a" }],
      [operation],
      [{
        id: "other-sponsor",
        status: "finalized",
        feeLamports: "4900000",
        failureCode: null,
        operationData: null
      }]
    ]);

    await expect(reserveWorkspaceReserveFundingFeeBudget(fake.db, {
      ...reservationInput,
      reservationKeys: ["deposit:1"],
      maxDailyFeeLamports: "5000000"
    })).resolves.toBe("daily_limit");
    expect(fake.updateCalls).toHaveLength(0);
  });

  it("settles actual fees and releases the unused reservation only at final verification", async () => {
    const active = {
      ...operation,
      feeLamports: "100000",
      operationData: {
        stage: "apply_submitted",
        feeBudgetReserved: true,
        actualFeeLamports: "15000",
        reservedFeeBudgetLamports: "100000",
        feePerTransactionLamports: "100000",
        feeBudgetSettledCount: 1,
        feeReservationKeys: ["deposit:1", "apply:1"]
      }
    };
    const fake = fakeDatabase([
      [{ workspaceId: "workspace-a" }],
      [active]
    ]);

    await expect(advanceWorkspaceReserveFundingOperation(fake.db, {
      workspaceId: "workspace-a",
      operationId: "reserve-operation",
      expectedStage: "apply_submitted",
      nextStage: "finalized",
      operationData: { finalAvailableBalanceBaseUnits: "1250000" },
      feeLamportsAdded: "5000",
      feeReservationConsumedLamports: "100000"
    })).resolves.toBe("updated");

    expect(fake.selectCalls[0]?.table).toBe(workspaceGasTanks);
    expect(fake.selectCalls[0]?.lock).toBe("update");
    expect(fake.selectCalls[1]?.table).toBe(gasTankOperations);
    expect(fake.selectCalls[1]?.lock).toBe("update");
    expect(fake.updateCalls[0]?.value).toMatchObject({
      status: "finalized",
      feeLamports: "20000",
      operationData: {
        actualFeeLamports: "20000",
        feeBudgetReserved: false,
        feeBudgetSettledCount: 2,
        feeBudgetSettledAt: expect.any(String)
      }
    });
  });

  it("treats a replay of the exact finalized fee settlement as an idempotent duplicate", async () => {
    const finalized = {
      ...operation,
      status: "finalized",
      feeLamports: "20000",
      operationData: {
        stage: "finalized",
        feeBudgetReserved: false,
        actualFeeLamports: "20000",
        reservedFeeBudgetLamports: "0",
        feePerTransactionLamports: "100000",
        feeReservationKeys: ["deposit:1", "apply:1"],
        feeReservationSettledKeys: ["deposit:1", "apply:1"],
        feeBudgetSettledCount: 2,
        finalAvailableBalanceBaseUnits: "1250000"
      }
    };
    const fake = fakeDatabase([
      [{ workspaceId: "workspace-a" }],
      [finalized]
    ]);

    await expect(advanceWorkspaceReserveFundingOperation(fake.db, {
      workspaceId: "workspace-a",
      operationId: "reserve-operation",
      expectedStage: "apply_submitted",
      nextStage: "finalized",
      operationData: { finalAvailableBalanceBaseUnits: "1250000" },
      feeLamportsAdded: "5000",
      feeReservationConsumedLamports: "100000",
      feeReservationKey: "apply:1"
    })).resolves.toBe("duplicate");
    expect(fake.updateCalls).toHaveLength(0);
  });

  it("does not consume a Reserve fee reservation key more than once", async () => {
    const active = {
      ...operation,
      feeLamports: "100000",
      operationData: {
        stage: "apply_submitted",
        feeBudgetReserved: true,
        actualFeeLamports: "15000",
        reservedFeeBudgetLamports: "100000",
        feePerTransactionLamports: "100000",
        feeBudgetSettledCount: 2,
        feeReservationKeys: ["deposit:1", "apply:1"],
        feeReservationSettledKeys: ["deposit:1", "apply:1"]
      }
    };
    const fake = fakeDatabase([
      [{ workspaceId: "workspace-a" }],
      [active]
    ]);

    await expect(advanceWorkspaceReserveFundingOperation(fake.db, {
      workspaceId: "workspace-a",
      operationId: "reserve-operation",
      expectedStage: "apply_submitted",
      nextStage: "finalized",
      feeReservationConsumedLamports: "100000",
      feeReservationKey: "apply:1"
    })).resolves.toBe("conflict");
    expect(fake.updateCalls).toHaveLength(0);
  });

  it("rejects skipped or unfunded stage attempts without mutating the operation", async () => {
    const fake = fakeDatabase([
      [{ workspaceId: "workspace-a" }],
      [{
        ...operation,
        operationData: {
          stage: "deposit_submitted",
          feeBudgetReserved: true,
          actualFeeLamports: "0",
          feeBudgetSettledCount: 0,
          feeReservationKeys: ["deposit:1"]
        }
      }]
    ]);

    await expect(advanceWorkspaceReserveFundingOperation(fake.db, {
      workspaceId: "workspace-a",
      operationId: "reserve-operation",
      expectedStage: "deposit_submitted",
      nextStage: "finalized",
      feeReservationConsumedLamports: "200000"
    })).resolves.toBe("conflict");
    expect(fake.updateCalls).toHaveLength(0);
  });
});
