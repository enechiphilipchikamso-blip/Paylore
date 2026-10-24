import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Database } from "./client";
import {
  applyVerifiedSubscriptionPayment
} from "./repositories";
import {
  subscriptionPayments,
  workspaceLedgerEntries,
  workspaceMemberships,
  workspaceNotifications,
  workspaceRetention,
  workspaceSubscriptions
} from "./schema";

function fakeDatabase() {
  let currentSubscription: Record<string, unknown> = {
    workspaceId: "workspace-a",
    status: "inactive",
    periodStart: null,
    periodEnd: null,
    cancelAtPeriodEnd: false
  };
  const payments = new Map<string, Record<string, unknown>>();
  const ledgerKeys = new Set<string>();
  const notificationKeys = new Set<string>();
  const ledgerRows: Array<Record<string, unknown>> = [];
  const notificationRows: Array<Record<string, unknown>> = [];
  const notificationAttempts: Array<Record<string, unknown>> = [];
  const members = [{ userId: "member-a" }, { userId: "member-b" }];

  function selectBuilder() {
    const state: { table?: unknown; returning?: boolean } = {};
    const builder: Record<string, any> = {};
    builder.from = vi.fn((table: unknown) => { state.table = table; return builder; });
    for (const method of ["where", "for", "limit", "orderBy"]) {
      builder[method] = vi.fn(() => builder);
    }
    builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
      let result: unknown[] = [];
      if (state.table === workspaceSubscriptions) result = [currentSubscription];
      if (state.table === workspaceMemberships) result = members;
      if (state.table === subscriptionPayments) {
        const prior = [...payments.values()].find((payment) => payment.signature === activeSignature);
        result = prior ? [{ workspaceId: prior.workspaceId, userId: prior.userId }] : [];
      }
      return Promise.resolve(result).then(resolve, reject);
    };
    return builder;
  }

  let activeSignature = "";
  const tx = {
    select: vi.fn(() => selectBuilder()),
    insert: vi.fn((table: unknown) => {
      let values: any;
      let requestedReturning: unknown;
      const builder: Record<string, any> = {};
      builder.values = vi.fn((next: unknown) => { values = next; return builder; });
      builder.onConflictDoNothing = vi.fn(() => builder);
      builder.returning = vi.fn((shape: unknown) => {
        requestedReturning = shape;
        if (table === subscriptionPayments) {
          const rows = Array.isArray(values) ? values : [values];
          const inserted: Array<{ id: string }> = [];
          for (const row of rows) {
            activeSignature = String(row.signature);
            if (payments.has(activeSignature)) continue;
            payments.set(activeSignature, { ...row, id: "payment-id" });
            inserted.push({ id: "payment-id" });
          }
          return Promise.resolve(inserted);
        }
        return Promise.resolve([]);
      });
      builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
        if (table === workspaceLedgerEntries) {
          const rows = Array.isArray(values) ? values : [values];
          for (const row of rows) {
            const key = String(row.idempotencyKey);
            if (ledgerKeys.has(key)) continue;
            ledgerKeys.add(key);
            ledgerRows.push(row);
          }
        }
        if (table === workspaceNotifications) {
          const rows = Array.isArray(values) ? values : [values];
          for (const row of rows) {
            notificationAttempts.push(row);
            const key = `${row.workspaceId}:${row.eventKey}:${row.recipientKey}`;
            if (notificationKeys.has(key)) continue;
            notificationKeys.add(key);
            notificationRows.push(row);
          }
        }
        return Promise.resolve(undefined).then(resolve, reject);
      };
      return builder;
    }),
    update: vi.fn((table: unknown) => {
      let changes: Record<string, unknown> = {};
      let returns = false;
      const builder: Record<string, any> = {};
      builder.set = vi.fn((value: Record<string, unknown>) => { changes = value; return builder; });
      builder.where = vi.fn(() => builder);
      builder.returning = vi.fn(() => {
        returns = true;
        currentSubscription = { ...currentSubscription, ...changes };
        return Promise.resolve([{
          status: currentSubscription.status,
          periodStart: currentSubscription.periodStart,
          periodEnd: currentSubscription.periodEnd,
          cancelAtPeriodEnd: currentSubscription.cancelAtPeriodEnd
        }]);
      });
      builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
        if (table === workspaceSubscriptions) currentSubscription = { ...currentSubscription, ...changes };
        return Promise.resolve(returns ? [currentSubscription] : undefined).then(resolve, reject);
      };
      return builder;
    })
  };
  const db = {
    transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx))
  };
  return {
    db: db as unknown as Database,
    ledgerRows,
    notificationRows,
    notificationAttempts,
    get subscription() { return currentSubscription; },
    get paymentRows() { return [...payments.values()]; }
  };
}

describe("verified subscription payment ledger and notifications", () => {
  beforeEach(() => vi.clearAllMocks());

  it("activates billing, records the finalized ledger event, and notifies members idempotently", async () => {
    const db = fakeDatabase();
    const now = new Date("2026-10-24T08:00:00.000Z");
    const input = {
      workspaceId: "workspace-a",
      userId: "admin-a",
      signature: "subscription-payment-signature",
      mint: "circle-devnet-usdc-mint",
      recipient: "configured-subscription-recipient",
      amountBaseUnits: "49000000",
      now
    };

    const first = await applyVerifiedSubscriptionPayment(db.db, input);

    expect(first).toMatchObject({ duplicate: false, status: "active" });
    expect(db.paymentRows).toHaveLength(1);
    expect(db.ledgerRows).toHaveLength(1);
    expect(db.ledgerRows[0]).toMatchObject({
      workspaceId: input.workspaceId,
      idempotencyKey: `subscription-payment:${input.signature}`,
      category: "billing",
      entryType: "subscription_payment",
      status: "finalized",
      amountBaseUnits: input.amountBaseUnits,
      transactionSignature: input.signature
    });
    expect(db.notificationRows).toHaveLength(2);
    expect(db.notificationRows.map((row) => row.recipientKey)).toEqual(["member-a", "member-b"]);
    expect(db.notificationRows[0]).toMatchObject({
      workspaceId: input.workspaceId,
      eventKey: `subscription-payment-confirmed:${input.signature}`,
      category: "Workspace & Billing",
      title: "Workspace active",
      destination: "/workspace/workspace-a/billing"
    });
    expect(db.notificationRows[0].body).toContain("Renewal is manual");
    expect(db.notificationRows[0].body).toContain("will not charge automatically");

    const duplicate = await applyVerifiedSubscriptionPayment(db.db, input);

    expect(duplicate).toMatchObject({ duplicate: true, status: "active" });
    expect(db.paymentRows).toHaveLength(1);
    expect(db.ledgerRows).toHaveLength(1);
    expect(db.notificationRows).toHaveLength(2);
    expect(db.notificationAttempts).toHaveLength(4);
    expect(db.notificationAttempts.every((row) =>
      row.eventKey === `subscription-payment-confirmed:${input.signature}`
    )).toBe(true);
  });
});
