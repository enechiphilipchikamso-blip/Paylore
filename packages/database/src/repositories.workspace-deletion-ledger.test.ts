import { describe, expect, it, vi } from "vitest";
import type { Database } from "./client";
import { cancelWorkspaceDeletion, requestWorkspaceDeletion } from "./repositories";

type Write = { method: string; value?: unknown };
function query(result: unknown) {
  const builder: Record<string, any> = {};
  for (const method of ["from", "where", "for", "limit", "orderBy"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}
function writeBuilder(writes: Write[], result: unknown[]) {
  const builder: Record<string, any> = {};
  builder.values = vi.fn((value: unknown) => { writes.push({ method: "values", value }); return builder; });
  builder.set = vi.fn((value: unknown) => { writes.push({ method: "set", value }); return builder; });
  builder.where = vi.fn(() => builder);
  builder.onConflictDoNothing = vi.fn(() => builder);
  builder.onConflictDoUpdate = vi.fn((value: unknown) => { writes.push({ method: "onConflictDoUpdate", value }); return builder; });
  builder.returning = vi.fn(() => builder);
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

describe("workspace deletion operational ledger", () => {
  it("records the scheduled closure as a pending non-financial ledger entry in the same transaction", async () => {
    const now = new Date("2026-10-25T12:00:00.000Z");
    const scheduledAt = new Date(now.getTime() + 72 * 60 * 60 * 1000);
    const writes: Write[] = [];
    const selectResults: unknown[][] = [[], []];
    const insertResults: unknown[][] = [
      [{ deletionRequestedAt: now, deletionScheduledAt: scheduledAt }],
      [],
      []
    ];
    const tx = {
      select: vi.fn(() => query(selectResults.shift() ?? [])),
      insert: vi.fn(() => writeBuilder(writes, insertResults.shift() ?? [])),
      update: vi.fn(() => writeBuilder(writes, []))
    };
    const db = {
      transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx))
    } as unknown as Database;

    await expect(requestWorkspaceDeletion(db, "workspace-a", now)).resolves.toMatchObject({
      created: true, scheduledAt
    });

    expect(writes.map((write) => write.value)).toContainEqual(expect.objectContaining({
      idempotencyKey: `workspace-deletion-request:${scheduledAt.getTime()}`,
      category: "recovery",
      entryType: "workspace_deletion_requested",
      status: "pending",
      amountBaseUnits: null,
      mint: null,
      referenceType: "workspace",
      referenceId: "workspace-a",
      metadata: expect.objectContaining({
        outcome: "pending",
        scheduledAt: scheduledAt.toISOString(),
        financialValueVerified: false,
        amountOmittedReason: "non_financial_outcome"
      })
    }));
  });

  it("records cancellation only after the pending deletion schedule was atomically canceled", async () => {
    const now = new Date("2026-10-25T12:00:00.000Z");
    const writes: Write[] = [];
    const selectResults: unknown[][] = [[]];
    const insertResults: unknown[][] = [[], []];
    const updated = [{ workspaceId: "workspace-a" }];
    const updateBuilder: Record<string, any> = {};
    updateBuilder.set = vi.fn((value: unknown) => { writes.push({ method: "set", value }); return updateBuilder; });
    updateBuilder.where = vi.fn(() => updateBuilder);
    updateBuilder.returning = vi.fn(() => updateBuilder);
    updateBuilder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve(updated).then(resolve, reject);
    const tx = {
      select: vi.fn(() => query(selectResults.shift() ?? [])),
      insert: vi.fn(() => writeBuilder(writes, insertResults.shift() ?? [])),
      update: vi.fn(() => updateBuilder)
    };
    const db = {
      transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx))
    } as unknown as Database;

    await expect(cancelWorkspaceDeletion(db, "workspace-a", now)).resolves.toEqual({ workspaceId: "workspace-a" });

    expect(writes.map((write) => write.value)).toContainEqual(expect.objectContaining({
      idempotencyKey: `workspace-deletion-canceled:${now.getTime()}`,
      category: "recovery",
      entryType: "workspace_deletion_canceled",
      status: "reversed",
      amountBaseUnits: null,
      mint: null,
      referenceType: "workspace",
      referenceId: "workspace-a",
      metadata: expect.objectContaining({
        outcome: "canceled",
        financialValueVerified: false,
        amountOmittedReason: "non_financial_outcome"
      })
    }));
  });
});
