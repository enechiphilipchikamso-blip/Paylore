import { describe, expect, it, vi } from "vitest";
import type { Database } from "./client";
import { createDueSubscriptionRenewalReminders } from "./repositories";
import { workspaceLedgerEntries, workspaceNotifications } from "./schema";

function query(result: unknown) {
  const builder: Record<string, any> = {};
  for (const method of ["from", "where", "orderBy", "limit"]) builder[method] = vi.fn(() => builder);
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

function fakeDatabase(selectResults: unknown[][], existingNotifications: Array<Record<string, unknown>> = []) {
  const insertCalls: Array<{ table: unknown; values: unknown }> = [];
  const notificationRows: Array<Record<string, unknown>> = [...existingNotifications];
  const ledgerRows: Array<Record<string, unknown>> = [];
  const notificationKeys = new Set<string>(existingNotifications.map((row) =>
    String(row.workspaceId) + ":" + String(row.eventKey) + ":" + String(row.recipientKey)
  ));
  const ledgerKeys = new Set<string>();
  let selectIndex = 0;
  const tx = {
    select: vi.fn(() => query(selectResults[selectIndex++ % selectResults.length] ?? [])),
    insert: vi.fn((table: unknown) => {
      let values: unknown;
      const builder: Record<string, any> = {};
      builder.values = vi.fn((next: unknown) => {
        values = next;
        insertCalls.push({ table, values: next });
        return builder;
      });
      builder.onConflictDoNothing = vi.fn(() => builder);
      builder.returning = vi.fn(async () => {
        const rows = Array.isArray(values) ? values as Array<Record<string, unknown>> : [values as Record<string, unknown>];
        const inserted: Array<Record<string, unknown>> = [];
        if (table === workspaceNotifications) {
          for (const row of rows) {
            const key = String(row.workspaceId) + ":" + String(row.eventKey) + ":" + String(row.recipientKey);
            if (notificationKeys.has(key)) continue;
            notificationKeys.add(key);
            notificationRows.push(row);
            inserted.push({ id: "notification-" + notificationRows.length });
          }
        } else if (table === workspaceLedgerEntries) {
          for (const row of rows) {
            const key = String(row.workspaceId) + ":" + String(row.idempotencyKey);
            if (ledgerKeys.has(key)) continue;
            ledgerKeys.add(key);
            ledgerRows.push(row);
            inserted.push({ id: "ledger-" + ledgerRows.length });
          }
        }
        return inserted;
      });
      return builder;
    })
  };
  const db = {
    transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx))
  };
  return { db: db as unknown as Database, tx, insertCalls, notificationRows, ledgerRows };
}

describe("subscription renewal reminder persistence", () => {
  it("records one idempotent non-financial ledger event and notifies every workspace member", async () => {
    const now = new Date("2026-10-24T08:00:00.000Z");
    const periodEnd = new Date(now.getTime() + 20 * 60 * 60 * 1000);
    const db = fakeDatabase([
      [{ workspaceId: "workspace-a", periodEnd, status: "active" }],
      [{ userId: "member-a" }, { userId: "member-b" }]
    ]);
    const first = await createDueSubscriptionRenewalReminders(db.db, now, 999);
    expect(first).toEqual({ subscriptionsProcessed: 1, notificationsCreated: 2, ledgerEntriesCreated: 1 });
    expect(db.tx.select).toHaveBeenCalledTimes(2);
    expect(db.notificationRows).toHaveLength(2);
    expect(db.notificationRows.map((value) => value.recipientKey)).toEqual(["member-a", "member-b"]);
    expect(db.notificationRows[0]).toMatchObject({
      workspaceId: "workspace-a",
      eventKey: "subscription-renewal-reminder:" + periodEnd.getTime() + ":1",
      category: "Workspace & Billing",
      title: "Subscription expires soon",
      destination: "/workspace/workspace-a/billing"
    });
    expect(db.notificationRows[0].body).toContain("Renewal is manual");
    expect(db.notificationRows[0].body).toContain("1 day");
    expect(db.ledgerRows).toHaveLength(1);
    expect(db.ledgerRows[0]).toMatchObject({
      workspaceId: "workspace-a",
      idempotencyKey: "subscription-renewal-reminder:" + periodEnd.getTime() + ":1",
      category: "billing",
      entryType: "subscription_renewal_reminder",
      status: "finalized",
      amountBaseUnits: null,
      mint: null,
      transactionSignature: null,
      metadata: { financial: false, periodEnd: periodEnd.toISOString(), reminderDays: 1, cancellationScheduled: false }
    });
    const repeated = await createDueSubscriptionRenewalReminders(db.db, now, 999);
    expect(repeated).toEqual({ subscriptionsProcessed: 1, notificationsCreated: 0, ledgerEntriesCreated: 0 });
    expect(db.notificationRows).toHaveLength(2);
    expect(db.ledgerRows).toHaveLength(1);
  });

  it("backfills an idempotent reminder ledger row when the notification already exists", async () => {
    const now = new Date("2026-10-24T08:00:00.000Z");
    const periodEnd = new Date(now.getTime() + 20 * 60 * 60 * 1000);
    const eventKey = "subscription-renewal-reminder:" + periodEnd.getTime() + ":1";
    const priorNotification = {
      workspaceId: "workspace-a",
      recipientKey: "member-a",
      eventKey,
      category: "Workspace & Billing",
      title: "Subscription expires soon",
      body: "Existing reminder",
      destination: "/workspace/workspace-a/billing",
      createdAt: now
    };
    const db = fakeDatabase([
      [{ workspaceId: "workspace-a", periodEnd, status: "active" }],
      [{ userId: "member-a" }]
    ], [priorNotification]);

    const result = await createDueSubscriptionRenewalReminders(db.db, now);

    expect(result).toEqual({ subscriptionsProcessed: 1, notificationsCreated: 0, ledgerEntriesCreated: 1 });
    expect(db.notificationRows).toEqual([priorNotification]);
    expect(db.ledgerRows).toHaveLength(1);
    expect(db.ledgerRows[0]).toMatchObject({
      workspaceId: "workspace-a",
      idempotencyKey: eventKey,
      entryType: "subscription_renewal_reminder",
      metadata: { financial: false, reminderDays: 1 }
    });
  });

  it("does not insert reminders when the paid period is more than seven days away", async () => {
    const now = new Date("2026-10-24T08:00:00.000Z");
    const db = fakeDatabase([[
      { workspaceId: "workspace-a", periodEnd: new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000), status: "cancel_scheduled" }
    ]]);
    await expect(createDueSubscriptionRenewalReminders(db.db, now)).resolves.toEqual({
      subscriptionsProcessed: 0, notificationsCreated: 0, ledgerEntriesCreated: 0
    });
    expect(db.tx.select).toHaveBeenCalledOnce();
    expect(db.insertCalls).toHaveLength(0);
  });

  it("preserves cancellation meaning and records the same non-financial event", async () => {
    const now = new Date("2026-10-24T08:00:00.000Z");
    const periodEnd = new Date(now.getTime() + 6 * 24 * 60 * 60 * 1000);
    const db = fakeDatabase([
      [{ workspaceId: "workspace-a", periodEnd, status: "cancel_scheduled" }],
      [{ userId: "member-a" }]
    ]);
    await createDueSubscriptionRenewalReminders(db.db, now);
    expect(db.notificationRows[0].body).toContain("Cancellation is scheduled");
    expect(db.notificationRows[0].body).toContain("Renew manually");
    expect(db.ledgerRows[0]).toMatchObject({
      idempotencyKey: "subscription-renewal-reminder:" + periodEnd.getTime() + ":7",
      metadata: { cancellationScheduled: true, financial: false }
    });
  });
});
