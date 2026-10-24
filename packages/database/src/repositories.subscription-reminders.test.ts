import { describe, expect, it, vi } from "vitest";
import type { Database } from "./client";
import { createDueSubscriptionRenewalReminders } from "./repositories";

function query(result: unknown) {
  const builder: Record<string, unknown> = {};
  for (const method of ["from", "where", "orderBy", "limit"]) builder[method] = vi.fn(() => builder);
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

function fakeDatabase(selectResults: unknown[][]) {
  const inserts: unknown[] = [];
  const conflictTargets: unknown[] = [];
  let selectIndex = 0;
  const tx = {
    select: vi.fn(() => query(selectResults[selectIndex++] ?? [])),
    insert: vi.fn(() => {
      const builder: Record<string, unknown> = {};
      builder.values = vi.fn((values: unknown) => { inserts.push(values); return builder; });
      builder.onConflictDoNothing = vi.fn((value: unknown) => {
        conflictTargets.push(value);
        return {
          returning: vi.fn(async () => {
            const values = inserts.at(-1);
            return Array.isArray(values) ? values : [];
          })
        };
      });
      return builder;
    })
  };
  const db = {
    transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx))
  };
  return { db: db as unknown as Database, tx, inserts, conflictTargets };
}

describe("subscription renewal reminder persistence", () => {
  it("uses stable one-day event keys and notifies each workspace member", async () => {
    const now = new Date("2026-10-24T08:00:00.000Z");
    const periodEnd = new Date(now.getTime() + 20 * 60 * 60 * 1000);
    const db = fakeDatabase([
      [{ workspaceId: "workspace-a", periodEnd, status: "active" }],
      [{ userId: "member-a" }, { userId: "member-b" }]
    ]);

    const result = await createDueSubscriptionRenewalReminders(db.db, now, 999);

    expect(result).toEqual({ subscriptionsProcessed: 1, notificationsCreated: 2 });
    expect(db.tx.select).toHaveBeenCalledTimes(2);
    const values = db.inserts[0] as Array<Record<string, unknown>>;
    expect(values).toHaveLength(2);
    expect(values.map((value) => value.recipientKey)).toEqual(["member-a", "member-b"]);
    expect(values[0]).toMatchObject({
      workspaceId: "workspace-a",
      eventKey: `subscription-renewal-reminder:${periodEnd.getTime()}:1`,
      category: "Workspace & Billing",
      title: "Subscription expires soon",
      destination: "/workspace/workspace-a/billing"
    });
    expect(values[0].body).toContain("Renewal is manual");
    expect(values[0].body).toContain("1 day");
    expect(db.conflictTargets[0]).toMatchObject({ target: expect.any(Array) });
  });

  it("does not insert reminders when the paid period is more than seven days away", async () => {
    const now = new Date("2026-10-24T08:00:00.000Z");
    const db = fakeDatabase([[
      { workspaceId: "workspace-a", periodEnd: new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000), status: "cancel_scheduled" }
    ]]);

    await expect(createDueSubscriptionRenewalReminders(db.db, now)).resolves.toEqual({
      subscriptionsProcessed: 0, notificationsCreated: 0
    });
    expect(db.tx.select).toHaveBeenCalledOnce();
    expect(db.inserts).toHaveLength(0);
  });

  it("preserves cancellation meaning rather than suggesting an automatic charge", async () => {
    const now = new Date("2026-10-24T08:00:00.000Z");
    const db = fakeDatabase([
      [{ workspaceId: "workspace-a", periodEnd: new Date(now.getTime() + 6 * 24 * 60 * 60 * 1000), status: "cancel_scheduled" }],
      [{ userId: "member-a" }]
    ]);

    await createDueSubscriptionRenewalReminders(db.db, now);
    const values = db.inserts[0] as Array<Record<string, unknown>>;
    expect(values[0].body).toContain("Cancellation is scheduled");
    expect(values[0].body).toContain("Renew manually");
  });
});
