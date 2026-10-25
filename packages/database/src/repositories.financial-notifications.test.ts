import { describe, expect, it, vi } from "vitest";
import type { Database } from "./client";
import {
  createWorkspaceNotificationForFinanceMembers,
  notifySubscriptionPaymentFailure,
  recordVerifiedGasTankFundingEvent
} from "./repositories";
import {
  workspaceGasTanks,
  workspaceLedgerEntries,
  workspaceMemberships,
  workspaceNotifications
} from "./schema";

function query(result: unknown) {
  const builder: Record<string, any> = {};
  builder.from = vi.fn(() => builder);
  builder.where = vi.fn(() => builder);
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

function fakeDatabase(members: Array<{ userId: string }>) {
  const notifications: Array<Record<string, unknown>> = [];
  const keys = new Set<string>();
  const insertCalls: Array<{ table: unknown; values: unknown }> = [];
  const tx = {
    select: vi.fn(() => query(members)),
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
        if (table !== workspaceNotifications) return [];
        const rows = Array.isArray(values)
          ? values as Array<Record<string, unknown>>
          : [values as Record<string, unknown>];
        const inserted: Array<{ id: string }> = [];
        for (const row of rows) {
          const key = `${row.workspaceId}:${row.eventKey}:${row.recipientKey}`;
          if (keys.has(key)) continue;
          keys.add(key);
          notifications.push(row);
          inserted.push({ id: `notification-${notifications.length}` });
        }
        return inserted;
      });
      return builder;
    })
  };
  const db = {
    select: tx.select,
    insert: tx.insert,
    transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx))
  };
  return { db: db as unknown as Database, tx, notifications, insertCalls };
}

describe("idempotent financial and recovery notifications", () => {
  it("notifies the payer and finance members once for failed transactions and intent mismatches", async () => {
    const fake = fakeDatabase([{ userId: "payer-user" }, { userId: "finance-user" }]);
    const now = new Date("2026-10-25T12:00:00.000Z");
    const failureInput = {
      workspaceId: "workspace-a",
      userId: "payer-user",
      signature: "failed-payment-signature",
      reason: "transaction_failed" as const,
      now
    };
    await expect(notifySubscriptionPaymentFailure(fake.db, failureInput)).resolves.toBe(2);
    await expect(notifySubscriptionPaymentFailure(fake.db, failureInput)).resolves.toBe(0);

    await expect(notifySubscriptionPaymentFailure(fake.db, {
      ...failureInput,
      signature: "mismatched-payment-signature",
      reason: "intent_mismatch"
    })).resolves.toBe(2);

    expect(fake.notifications).toHaveLength(4);
    expect(fake.notifications).toContainEqual(expect.objectContaining({
      workspaceId: "workspace-a",
      recipientKey: "payer-user",
      eventKey: "subscription-payment-failure:failed-payment-signature",
      title: "Subscription payment failed",
      destination: "/workspace/workspace-a/billing"
    }));
    expect(fake.notifications).toContainEqual(expect.objectContaining({
      recipientKey: "finance-user",
      eventKey: "subscription-payment-failure:failed-payment-signature",
      title: "Subscription payment failed"
    }));
    expect(fake.notifications).toContainEqual(expect.objectContaining({
      recipientKey: "payer-user",
      eventKey: "subscription-payment-failure:mismatched-payment-signature",
      title: "Subscription payment was not accepted",
      body: expect.stringContaining("did not match")
    }));
    expect(fake.notifications).toContainEqual(expect.objectContaining({
      recipientKey: "finance-user",
      eventKey: "subscription-payment-failure:mismatched-payment-signature",
      title: "Subscription payment was not accepted"
    }));
  });

  it("backfills missing finance notices on a replay while preserving one row per event and recipient", async () => {
    const fake = fakeDatabase([{ userId: "admin-a" }, { userId: "finance-a" }]);
    const notice = {
      workspaceId: "workspace-a",
      eventKey: "payroll-recovery:allocation-a",
      category: "Recovery & Offboarding",
      title: "Payroll allocation recovered",
      body: "A finalized recovery transaction was reconciled with the allocation's on-chain state.",
      destination: "/workspace/workspace-a/payroll/run-a",
      now: new Date("2026-10-25T12:00:00.000Z")
    };
    await expect(createWorkspaceNotificationForFinanceMembers(fake.db, notice)).resolves.toBe(2);
    await expect(createWorkspaceNotificationForFinanceMembers(fake.db, notice)).resolves.toBe(0);

    expect(fake.notifications).toHaveLength(2);
    expect(fake.notifications.map((row) => row.recipientKey)).toEqual(["admin-a", "finance-a"]);
    expect(fake.notifications.every((row) =>
      row.eventKey === notice.eventKey &&
      row.destination === notice.destination
    )).toBe(true);
  });
});


describe("Gas Tank funding notifications", () => {
  it("emits one actionable finance notice for a finalized funding event and reuses it on replay", async () => {
    const notifications: Array<Record<string, unknown>> = [];
    const ledgerKeys = new Set<string>();
    const notificationKeys = new Set<string>();
    const ledgerRows: Array<Record<string, unknown>> = [];
    const tx = {
      select: vi.fn(() => {
        let table: unknown;
        const builder: Record<string, any> = {};
        builder.from = vi.fn((value: unknown) => { table = value; return builder; });
        for (const method of ["where", "for", "limit"]) builder[method] = vi.fn(() => builder);
        builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
          const rows = table === workspaceGasTanks
            ? [{ workspaceId: "workspace-a", address: "gas-tank-a" }]
            : table === workspaceMemberships
              ? [{ userId: "admin-a" }, { userId: "finance-a" }]
              : table === workspaceLedgerEntries
                ? ledgerRows
                : [];
          return Promise.resolve(rows).then(resolve, reject);
        };
        return builder;
      }),
      insert: vi.fn((table: unknown) => {
        let values: unknown;
        const builder: Record<string, any> = {};
        builder.values = vi.fn((next: unknown) => { values = next; return builder; });
        builder.onConflictDoNothing = vi.fn(() => builder);
        builder.returning = vi.fn(async () => {
          if (table !== workspaceLedgerEntries) return [];
          const rows = Array.isArray(values)
            ? values as Array<Record<string, unknown>>
            : [values as Record<string, unknown>];
          const inserted: Array<{ id: string }> = [];
          for (const row of rows) {
            const key = String(row.workspaceId) + ":" + String(row.idempotencyKey);
            if (ledgerKeys.has(key)) continue;
            ledgerKeys.add(key);
            ledgerRows.push(row);
            inserted.push({ id: "ledger-" + ledgerRows.length });
          }
          return inserted;
        });
        builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
          if (table === workspaceNotifications) {
            const rows = Array.isArray(values)
              ? values as Array<Record<string, unknown>>
              : [values as Record<string, unknown>];
            for (const row of rows) {
              const key = String(row.workspaceId) + ":" + String(row.eventKey) + ":" + String(row.recipientKey);
              if (notificationKeys.has(key)) continue;
              notificationKeys.add(key);
              notifications.push(row);
            }
          }
          return Promise.resolve(undefined).then(resolve, reject);
        };
        return builder;
      }),
      update: vi.fn(() => {
        const builder: Record<string, any> = {};
        builder.set = vi.fn(() => builder);
        builder.where = vi.fn(() => builder);
        builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
          Promise.resolve(undefined).then(resolve, reject);
        return builder;
      })
    };
    const db = {
      transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx))
    } as unknown as Database;
    const input = {
      workspaceId: "workspace-a",
      destination: "gas-tank-a",
      source: "contributor-wallet",
      signature: "funding-signature",
      amountLamports: "1000000",
      confirmedBalanceLamports: "9000000",
      now: new Date("2026-10-25T12:00:00.000Z")
    };

    await expect(recordVerifiedGasTankFundingEvent(db, input)).resolves.toEqual({ status: "recorded" });
    await expect(recordVerifiedGasTankFundingEvent(db, input)).resolves.toEqual({ status: "duplicate" });
    await expect(recordVerifiedGasTankFundingEvent(db, {
      ...input,
      amountLamports: "1000001",
      confirmedBalanceLamports: "9000001"
    })).resolves.toEqual({ status: "conflict" });

    expect(ledgerRows).toHaveLength(1);
    expect(notifications).toHaveLength(2);
    expect(tx.update).toHaveBeenCalledTimes(2);
    expect(notifications.map((notice) => notice.recipientKey)).toEqual(["admin-a", "finance-a"]);
    expect(notifications.every((notice) =>
      notice.eventKey === "gas-tank-funding:funding-signature"
    )).toBe(true);
    expect(notifications[0]).toMatchObject({
      title: "Gas Tank funded",
      destination: "/workspace/workspace-a/gas-tank"
    });
  });
});
