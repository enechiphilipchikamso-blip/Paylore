import { describe, expect, it, vi } from "vitest";
import type { Database } from "./client";
import {
  completeContributorOffboarding,
  listUserNotifications,
  markAllUserNotificationsRead,
  markUserNotificationRead
} from "./repositories";
import {
  contributorConfidentialAccounts,
  contributors,
  payrollAllocations,
  userNotifications,
  workspaceMemberships,
  workspaceNotifications
} from "./schema";

type Row = Record<string, unknown>;
type Write = { table: unknown; method: string; value?: unknown };

function selectBuilder(rowsByTable: Map<unknown, unknown[]>) {
  let source: unknown;
  const builder: Record<string, any> = {};
  builder.from = vi.fn((table: unknown) => {
    source = table;
    return builder;
  });
  for (const method of ["innerJoin", "where", "orderBy", "limit", "for"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(rowsByTable.get(source) ?? []).then(resolve, reject);
  return builder;
}

function updateBuilder(
  table: unknown,
  result: unknown[],
  writes: Write[]
) {
  const builder: Record<string, any> = {};
  builder.set = vi.fn((value: unknown) => {
    writes.push({ table, method: "set", value });
    return builder;
  });
  builder.where = vi.fn(() => builder);
  builder.returning = vi.fn(() => builder);
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

describe("workspace closure notification handoff", () => {
  it("notifies the departing contributor and organization administrators without payroll details", async () => {
    const now = new Date("2026-10-26T12:00:00.000Z");
    const writes: Write[] = [];
    const rowsByTable = new Map<unknown, unknown[]>([
      [contributors, [{ id: "contributor-a", displayName: "Ada Example", lifecycle: "active" }]],
      [payrollAllocations, []],
      [contributorConfidentialAccounts, []],
      [workspaceMemberships, [{ userId: "admin-a", role: "organization_admin" }]]
    ]);
    const tx = {
      select: vi.fn(() => selectBuilder(rowsByTable)),
      update: vi.fn((table: unknown) => updateBuilder(table, [], writes)),
      delete: vi.fn((table: unknown) => updateBuilder(table, [], writes)),
      insert: vi.fn((table: unknown) => {
        let value: unknown;
        const builder: Record<string, any> = {};
        builder.values = vi.fn((next: unknown) => {
          value = next;
          writes.push({ table, method: "values", value: next });
          return builder;
        });
        builder.onConflictDoNothing = vi.fn(() => builder);
        builder.onConflictDoUpdate = vi.fn(() => builder);
        builder.returning = vi.fn(() => builder);
        builder.then = (resolve: (result: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve([]).then(resolve, reject);
        return builder;
      })
    };
    const db = {
      transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx))
    } as unknown as Database;

    await expect(completeContributorOffboarding(db, {
      workspaceId: "workspace-a",
      contributorId: "contributor-a",
      userId: "contributor-user",
      walletAddress: "contributor-wallet",
      closeTransactionSignature: null,
      now
    })).resolves.toBe("completed");

    const notifications = writes
      .filter((write) => write.table === workspaceNotifications && write.method === "values")
      .flatMap((write) => Array.isArray(write.value) ? write.value : [write.value]) as Row[];
    expect(notifications).toHaveLength(2);
    expect(notifications).toContainEqual(expect.objectContaining({
      recipientKey: "contributor-user",
      eventKey: "contributor-offboarding-completed:contributor-a",
      title: "You have left the workspace",
      body: "Workspace access has been removed. Your confidential account remains under your control and was not closed by Paylore."
    }));
    expect(notifications).toContainEqual(expect.objectContaining({
      recipientKey: "admin-a",
      eventKey: "contributor-offboarding-completed:contributor-a",
      title: "Contributor departure completed",
      body: "Ada Example left the workspace without closing their confidential account. The account remains under the contributor's control."
    }));
    expect(notifications.every((notice) =>
      notice.category === "Recovery & Offboarding" &&
      !("amountBaseUnits" in notice) &&
      !("transactionSignature" in notice) &&
      !("walletAddress" in notice)
    )).toBe(true);
  });

  it("merges retained closure notices into the account center and marks them read by recipient", async () => {
    const retainedDate = new Date("2026-10-24T12:00:00.000Z");
    const currentDate = new Date("2026-10-25T12:00:00.000Z");
    const currentRows = [{
      id: "workspace-notice",
      workspaceId: "current-workspace",
      workspaceName: "Current workspace",
      category: "Workspace & Billing",
      title: "Subscription confirmed",
      body: "The subscription period is active.",
      destination: "/workspace/current-workspace/billing",
      readAt: null,
      createdAt: currentDate
    }];
    const retainedRows = [{
      id: "retained-notice",
      workspaceId: "deleted-workspace",
      workspaceName: "Former workspace",
      category: "Data Retention & Deletion",
      title: "Workspace application data deleted",
      body: "The application records were deleted; blockchain state remains.",
      destination: "/notifications",
      readAt: null,
      createdAt: retainedDate
    }];
    const rowsByTable = new Map<unknown, unknown[]>([
      [workspaceNotifications, currentRows],
      [userNotifications, retainedRows]
    ]);
    const db = {
      select: vi.fn(() => selectBuilder(rowsByTable)),
      update: vi.fn((table: unknown) => updateBuilder(
        table,
        table === userNotifications ? [{ id: "retained-notice" }] : [],
        []
      ))
    } as unknown as Database;

    const listed = await listUserNotifications(db, "user-a");
    expect(listed.map((notice) => notice.id)).toEqual(["workspace-notice", "retained-notice"]);
    expect(listed[1]).toMatchObject({
      workspaceId: "deleted-workspace",
      workspaceName: "Former workspace",
      destination: "/notifications",
      title: "Workspace application data deleted"
    });
    await expect(markUserNotificationRead(db, {
      recipientKey: "user-a",
      notificationId: "retained-notice",
      now: new Date("2026-10-26T12:00:00.000Z")
    })).resolves.toEqual({ id: "retained-notice" });
  });

  it("marks both current-workspace and retained closure notices read in one transaction", async () => {
    const writes: Write[] = [];
    const tx = {
      update: vi.fn((table: unknown) => updateBuilder(
        table,
        table === workspaceNotifications ? [{ id: "current-notice" }] : [{ id: "retained-notice" }],
        writes
      ))
    };
    const db = {
      transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx))
    } as unknown as Database;

    await expect(markAllUserNotificationsRead(db, {
      recipientKey: "user-a",
      now: new Date("2026-10-26T12:00:00.000Z")
    })).resolves.toBe(2);
    expect(tx.update).toHaveBeenCalledTimes(2);
    expect(writes.filter((write) => write.method === "set")).toHaveLength(2);
  });
});
