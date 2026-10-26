import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { getTableConfig } from "drizzle-orm/pg-core";
import type { Database } from "./client";
import {
  cleanupEligibleContributorAssociations,
  permanentlyDeleteEligibleWorkspace
} from "./repositories";
import { workspaceDeletionAudit } from "./schema";

type Write = { method: string; value?: unknown };
type QueryObservations = { limits: number[]; locks: string[] };

function query(result: unknown, observations: QueryObservations) {
  const builder: Record<string, any> = {};
  for (const method of ["from", "innerJoin", "where", "orderBy"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.limit = vi.fn((value: number) => {
    observations.limits.push(value);
    return builder;
  });
  builder.for = vi.fn((value: string) => {
    observations.locks.push(value);
    return builder;
  });
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

function mutation(result: unknown[], writes: Write[], method: string) {
  const builder: Record<string, any> = {};
  builder.values = vi.fn((value: unknown) => {
    writes.push({ method: "values", value });
    return builder;
  });
  builder.onConflictDoUpdate = vi.fn((value: unknown) => {
    writes.push({ method: "onConflictDoUpdate", value });
    return builder;
  });
  builder.where = vi.fn(() => builder);
  builder.returning = vi.fn(() => builder);
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  if (method === "delete") {
    writes.push({ method: "delete", value: result });
  }
  return builder;
}

const now = new Date("2026-10-26T12:00:00.000Z");
const eligibleRetention = {
  deletionRequestedAt: new Date("2026-10-20T12:00:00.000Z"),
  deletionScheduledAt: new Date("2026-10-23T12:00:00.000Z"),
  deletionCanceledAt: null,
  deletedAt: null,
  lastActivityAt: new Date("2025-09-20T12:00:00.000Z")
};

function eligiblePurgeSelectResults() {
  return [
    [eligibleRetention],
    [],
    [{ status: "inactive" }],
    [],
    [],
    [],
    [],
    []
  ] as unknown[][];
}

function createTransaction(
  selectResults: unknown[][],
  deleteResults: unknown[][],
  writes: Write[],
  observations: QueryObservations,
  deletedTables: unknown[]
) {
  return {
    select: vi.fn(() => query(selectResults.shift() ?? [], observations)),
    insert: vi.fn(() => mutation([], writes, "insert")),
    delete: vi.fn((table: unknown) => {
      deletedTables.push(table);
      return mutation(deleteResults.shift() ?? [], writes, "delete");
    })
  };
}

function createPurgeDb(
  transactionResults: Array<{ selectResults: unknown[][]; deleteResults: unknown[][] }>,
  options: { serializeTransactions?: boolean } = {}
) {
  const writes: Write[] = [];
  const observations: QueryObservations = { limits: [], locks: [] };
  const deletedTables: unknown[] = [];
  let transactionTail: Promise<unknown> = Promise.resolve();

  const db = {
    transaction: vi.fn((callback: (tx: ReturnType<typeof createTransaction>) => unknown) => {
      const next = transactionResults.shift() ?? { selectResults: [], deleteResults: [] };
      const run = transactionTail.then(async () => {
        const tx = createTransaction(
          [...next.selectResults],
          [...next.deleteResults],
          writes,
          observations,
          deletedTables
        );
        return callback(tx);
      });
      if (options.serializeTransactions) {
        transactionTail = run.then(() => undefined, () => undefined);
      } else {
        transactionTail = Promise.resolve();
      }
      return run;
    })
  } as unknown as Database;

  return { db, writes, observations, deletedTables };
}

function successfulPurgeResult() {
  return {
    selectResults: eligiblePurgeSelectResults(),
    deleteResults: [[], [], [], [{ id: "workspace-a" }]]
  };
}

describe("workspace deletion purge contract", () => {
  it("bounds each contributor-association cleanup query to the declared maximum batch", async () => {
    const observations: QueryObservations = { limits: [], locks: [] };
    const db = {
      select: vi.fn(() => query([], observations))
    } as unknown as Database;

    await expect(cleanupEligibleContributorAssociations(db, now, 10_000)).resolves.toEqual({
      removed: 0,
      deferred: 0
    });
    expect(observations.limits).toEqual([500]);
  });

  it("bounds the default contributor-association cleanup query to one page", async () => {
    const observations: QueryObservations = { limits: [], locks: [] };
    const db = {
      select: vi.fn(() => query([], observations))
    } as unknown as Database;

    await expect(cleanupEligibleContributorAssociations(db, now)).resolves.toEqual({
      removed: 0,
      deferred: 0
    });
    expect(observations.limits).toEqual([100]);
  });

  it("retains only the minimal keyed outcome after the workspace row is purged", async () => {
    const config = getTableConfig(workspaceDeletionAudit);
    const migration = readFileSync(
      new URL("../drizzle/0004_workspace_deletion_audit.sql", import.meta.url),
      "utf8"
    );

    expect(config.name).toBe("workspace_deletion_audit");
    expect(config.columns.map((column) => column.name).sort()).toEqual([
      "blocker_code",
      "canceled_at",
      "completed_at",
      "outcome",
      "requested_at",
      "scheduled_at",
      "updated_at",
      "workspace_id"
    ]);
    expect(workspaceDeletionAudit.workspaceId.primary).toBe(true);
    expect(config.foreignKeys).toHaveLength(0);
    expect(migration).toContain('"workspace_id" uuid PRIMARY KEY NOT NULL');
    expect(migration).not.toMatch(/FOREIGN KEY|REFERENCES\s+"workspaces"/i);

    const { db, writes, deletedTables, observations } = createPurgeDb([
      successfulPurgeResult()
    ]);
    await expect(permanentlyDeleteEligibleWorkspace(db, {
      workspaceId: "workspace-a",
      now
    })).resolves.toEqual({ status: "deleted" });

    const insertedAudit = writes.find((write) =>
      write.method === "values" &&
      write.value &&
      typeof write.value === "object" &&
      "workspaceId" in write.value &&
      (write.value as Record<string, unknown>).workspaceId === "workspace-a"
    )?.value as Record<string, unknown> | undefined;

    expect(insertedAudit).toEqual({
      workspaceId: "workspace-a",
      requestedAt: eligibleRetention.deletionRequestedAt,
      scheduledAt: eligibleRetention.deletionScheduledAt,
      canceledAt: null,
      completedAt: now,
      outcome: "deleted",
      blockerCode: null,
      updatedAt: now
    });
    expect(writes).toContainEqual({
      method: "onConflictDoUpdate",
      value: expect.objectContaining({
        target: workspaceDeletionAudit.workspaceId,
        set: expect.objectContaining({ outcome: "deleted", completedAt: now })
      })
    });
    expect(deletedTables).toHaveLength(4);
    expect(observations.locks).toContain("update");
  });

  it("returns the prior deleted result on repeat without overwriting the retained audit outcome", async () => {
    const { db, writes, deletedTables } = createPurgeDb([
      successfulPurgeResult(),
      { selectResults: [[], [{ outcome: "deleted" }]], deleteResults: [] }
    ], { serializeTransactions: true });

    await expect(permanentlyDeleteEligibleWorkspace(db, {
      workspaceId: "workspace-a",
      now
    })).resolves.toEqual({ status: "deleted" });
    await expect(permanentlyDeleteEligibleWorkspace(db, {
      workspaceId: "workspace-a",
      now
    })).resolves.toEqual({ status: "deleted" });

    expect(deletedTables).toHaveLength(4);
    const auditOutcomes = writes
      .filter((write) => write.method === "values" && write.value && typeof write.value === "object" &&
        "workspaceId" in write.value)
      .map((write) => (write.value as Record<string, unknown>).outcome);
    expect(auditOutcomes).toEqual(["deleted"]);
  });

  it("serializes concurrent purge attempts into one destructive deletion and a stable terminal outcome", async () => {
    const { db, writes, deletedTables, observations } = createPurgeDb([
      successfulPurgeResult(),
      { selectResults: [[], [{ outcome: "deleted" }]], deleteResults: [] }
    ], { serializeTransactions: true });

    const results = await Promise.all([
      permanentlyDeleteEligibleWorkspace(db, { workspaceId: "workspace-a", now }),
      permanentlyDeleteEligibleWorkspace(db, { workspaceId: "workspace-a", now })
    ]);

    expect(results).toEqual([{ status: "deleted" }, { status: "deleted" }]);
    expect(deletedTables).toHaveLength(4);
    expect(db.transaction).toHaveBeenCalledTimes(2);
    expect(observations.locks).toContain("update");
    const retainedRows = writes.filter((write) =>
      write.method === "values" &&
      write.value &&
      typeof write.value === "object" &&
      "workspaceId" in write.value
    );
    expect(retainedRows).toHaveLength(1);
    expect((retainedRows[0].value as Record<string, unknown>).outcome).toBe("deleted");
  });
});
