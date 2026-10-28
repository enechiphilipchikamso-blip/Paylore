import { describe, expect, it, vi } from "vitest";
import type { Database } from "./client";
import { archiveExpiredWorkspaceSubscriptions, cancelWorkspaceDeletion, createWorkspaceRetentionNotice, requestWorkspaceDeletion } from "./repositories";

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
    const selectResults: unknown[][] = [[], [{ userId: "admin-a" }, { userId: "contributor-a" }]];
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
    const notices = writes.flatMap((write) => Array.isArray(write.value) ? write.value : [write.value])
      .filter((value): value is Record<string, unknown> => Boolean(value) &&
        typeof value === "object" && "eventKey" in value);
    expect(notices).toHaveLength(2);
    expect(notices.map((notice) => notice.recipientKey)).toEqual(["admin-a", "contributor-a"]);
    expect(notices.every((notice) =>
      notice.eventKey === `workspace-deletion-pending:${scheduledAt.getTime()}`
    )).toBe(true);
  });

  it("records cancellation only after the pending deletion schedule was atomically canceled", async () => {
    const now = new Date("2026-10-25T12:00:00.000Z");
    const writes: Write[] = [];
    const selectResults: unknown[][] = [[{ userId: "admin-a" }, { userId: "contributor-a" }]];
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
    const notices = writes.flatMap((write) => Array.isArray(write.value) ? write.value : [write.value])
      .filter((value): value is Record<string, unknown> => Boolean(value) &&
        typeof value === "object" && "eventKey" in value);
    expect(notices).toHaveLength(2);
    expect(notices.map((notice) => notice.recipientKey)).toEqual(["admin-a", "contributor-a"]);
    expect(notices.every((notice) =>
      notice.eventKey === `workspace-deletion-canceled:${now.getTime()}`
    )).toBe(true);
    expect(notices).toContainEqual(expect.objectContaining({
      recipientKey: "admin-a",
      title: "Workspace deletion request canceled",
      body: "The pending application-data deletion request was canceled. No application data was deleted."
    }));
    expect(notices).toContainEqual(expect.objectContaining({
      recipientKey: "contributor-a",
      title: "Workspace deletion request canceled"
    }));
  });
});


describe("workspace retention notices", () => {
  it("notifies administrators and contributors once per inactivity milestone without member-specific data", async () => {
    const now = new Date("2026-10-25T12:00:00.000Z");
    const lastActivityAt = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000);
    const writes: Write[] = [];
    const members = [{ userId: "admin-a" }, { userId: "contributor-a" }];
    const selectResults: unknown[][] = [
      [{ lastActivityAt, lastNoticeDay: 0 }],
      members,
      [{ lastActivityAt, lastNoticeDay: 30 }]
    ];
    const tx = {
      select: vi.fn(() => query(selectResults.shift() ?? [])),
      insert: vi.fn(() => writeBuilder(writes, [{ id: "notice-admin" }, { id: "notice-contributor" }])),
      update: vi.fn(() => writeBuilder(writes, []))
    };
    const db = {
      transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx))
    } as unknown as Database;
    const input = {
      workspaceId: "workspace-a",
      lastActivityAt,
      day: 30,
      title: "Workspace inactivity notice",
      body: "Your workspace has been inactive for 30 days.",
      destination: "/workspace/workspace-a/settings/deletion",
      now
    };

    await expect(createWorkspaceRetentionNotice(db, input)).resolves.toEqual({
      created: 2,
      advanced: true
    });
    await expect(createWorkspaceRetentionNotice(db, input)).resolves.toEqual({
      created: 0,
      advanced: false
    });

    const notices = writes.flatMap((write) => Array.isArray(write.value) ? write.value : [write.value])
      .filter((value): value is Record<string, unknown> => Boolean(value) &&
        typeof value === "object" && "eventKey" in value);
    expect(notices).toHaveLength(2);
    expect(notices.map((notice) => notice.recipientKey)).toEqual(["admin-a", "contributor-a"]);
    expect(notices.every((notice) =>
      notice.workspaceId === "workspace-a" &&
      notice.eventKey === `workspace-inactivity:${lastActivityAt.getTime()}:30` &&
      notice.category === "Data Retention & Deletion" &&
      notice.title === input.title &&
      notice.body === input.body &&
      !("amountBaseUnits" in notice) &&
      !("walletAddress" in notice)
    )).toBe(true);
  });
});

describe("workspace archive notifications", () => {
  it("notifies workspace members once when an expired subscription is archived", async () => {
    const now = new Date("2026-10-25T12:00:00.000Z");
    const periodEnd = new Date("2026-10-24T12:00:00.000Z");
    const writes: Write[] = [];
    let pending: Array<{ workspaceId: string; periodEnd: Date }> = [
      { workspaceId: "workspace-a", periodEnd }
    ];
    const members = [{ userId: "admin-a" }, { userId: "contributor-a" }];
    const tx = {
      update: vi.fn(() => {
        const builder: Record<string, any> = {};
        builder.set = vi.fn(() => builder);
        builder.where = vi.fn(() => builder);
        builder.returning = vi.fn(() => {
          const returned = pending;
          pending = [];
          return Promise.resolve(returned);
        });
        return builder;
      }),
      insert: vi.fn(() => writeBuilder(writes, [])),
      select: vi.fn(() => query(members))
    };
    const db = {
      transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx))
    } as unknown as Database;

    await expect(archiveExpiredWorkspaceSubscriptions(db, now)).resolves.toBe(1);
    await expect(archiveExpiredWorkspaceSubscriptions(db, now)).resolves.toBe(0);

    const notices = writes.flatMap((write) => Array.isArray(write.value) ? write.value : [write.value])
      .filter((value): value is Record<string, unknown> => Boolean(value) &&
        typeof value === "object" && "eventKey" in value);
    expect(notices).toHaveLength(2);
    expect(notices.map((notice) => notice.recipientKey)).toEqual(["admin-a", "contributor-a"]);
    expect(notices.every((notice) =>
      notice.eventKey === `workspace-archived:workspace-a:${periodEnd.getTime()}`
    )).toBe(true);
    expect(notices[0]).toMatchObject({
      title: "Workspace is now in Read-Only Archive",
      destination: "/workspace/workspace-a/billing"
    });
  });
});
