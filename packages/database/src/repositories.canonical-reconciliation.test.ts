import { describe, expect, it, vi } from "vitest";
import type { Database } from "./client";
import { getCanonicalReconciliationCursor, persistCanonicalReconciliationScanPage } from "./repositories";

function mutation(calls: Array<{ method: string; value?: unknown }>, result: unknown, reject = false) {
  const builder: Record<string, any> = {};
  builder.values = vi.fn((value: unknown) => { calls.push({ method: "values", value }); return builder; });
  builder.onConflictDoNothing = vi.fn(() => builder);
  builder.onConflictDoUpdate = vi.fn((value: unknown) => { calls.push({ method: "onConflictDoUpdate", value }); return builder; });
  builder.returning = vi.fn(() => builder);
  builder.then = (resolve: (value: unknown) => unknown, fail?: (reason: unknown) => unknown) =>
    (reject ? Promise.reject(new Error("event insert failed")) : Promise.resolve(result)).then(resolve, fail);
  return builder;
}

function fakeDb(insertResults: unknown[][], failFirst = false) {
  const writes: Array<{ method: string; value?: unknown }> = [];
  let index = 0;
  const tx = { insert: vi.fn(() => mutation(writes, insertResults[index++] ?? [], failFirst && index === 1)) };
  const db = { transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)) };
  return { db: db as unknown as Database, tx, writes };
}

const event = {
  provider: "canonical-rpc-scanner",
  providerEventId: "signature-1",
  transactionSignature: "signature-1",
  transactionSlot: "42",
  accountAddress: "watched-address",
  eventType: "payroll-recover_claim",
  payload: { signature: "signature-1", slot: 42, type: "payroll-recover_claim", sourceAddress: "watched-address" },
  status: "received"
} as const;

describe("canonical reconciliation cursor persistence", () => {
  it("inserts discovered events and updates the cursor in one transaction", async () => {
    const fake = fakeDb([[{ id: "event-1" }], []]);
    await expect(persistCanonicalReconciliationScanPage(fake.db, {
      address: "watched-address",
      highWaterSignature: "signature-newest",
      backfillBeforeSignature: "signature-oldest",
      backfillUntilSignature: null,
      events: [event],
      now: new Date("2026-10-25T12:00:00Z")
    })).resolves.toEqual({ inserted: 1, duplicates: 0 });

    expect(fake.db.transaction).toHaveBeenCalledOnce();
    expect(fake.tx.insert).toHaveBeenCalledTimes(2);
    expect(fake.writes).toContainEqual(expect.objectContaining({
      method: "values",
      value: expect.objectContaining({ address: "watched-address", highWaterSignature: "signature-newest" })
    }));
    expect(fake.writes).toContainEqual(expect.objectContaining({ method: "onConflictDoUpdate" }));
  });

  it("counts a replay as a duplicate while still committing the cursor", async () => {
    const fake = fakeDb([[], []]);
    await expect(persistCanonicalReconciliationScanPage(fake.db, {
      address: "watched-address",
      highWaterSignature: "signature-newest",
      backfillBeforeSignature: null,
      backfillUntilSignature: null,
      events: [event]
    })).resolves.toEqual({ inserted: 0, duplicates: 1 });
    expect(fake.tx.insert).toHaveBeenCalledTimes(2);
  });

  it("does not write a cursor when the event insert fails", async () => {
    const fake = fakeDb([[]], true);
    await expect(persistCanonicalReconciliationScanPage(fake.db, {
      address: "watched-address",
      highWaterSignature: "signature-newest",
      backfillBeforeSignature: null,
      backfillUntilSignature: null,
      events: [event]
    })).rejects.toThrow("event insert failed");
    expect(fake.tx.insert).toHaveBeenCalledOnce();
  });
});
