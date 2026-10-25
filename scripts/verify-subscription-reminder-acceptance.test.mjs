import test from "node:test";
import assert from "node:assert/strict";
import { verifySubscriptionReminderOutcome } from "./verify-subscription-reminder-acceptance.mjs";

const baseUrl = "https://paylore.example";
const workspaceId = "workspace-a";
const cookie = "session=never-print-this-value";
const periodEnd = "2026-10-25T08:00:00.000Z";
const eventKey = `subscription-renewal-reminder:${Date.parse(periodEnd)}:7`;
const notification = {
  eventKey,
  category: "Workspace & Billing",
  title: "Subscription expires soon",
  body: "Your workspace subscription ends in 7 days. Renewal is manual.",
  destination: "/workspace/workspace-a/billing"
};
const ledgerEntry = {
  idempotencyKey: eventKey,
  category: "billing",
  entryType: "subscription_renewal_reminder",
  status: "finalized",
  amountBaseUnits: null,
  mint: null,
  transactionSignature: null,
  referenceType: "workspace_subscription",
  metadata: {
    financial: false,
    periodEnd,
    reminderDays: 7,
    cancellationScheduled: false
  }
};

test("acceptance requires one matching notification and one non-financial ledger record", async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url: new URL(url), options });
    if (new URL(url).pathname.endsWith("/notifications")) {
      return new Response(JSON.stringify({ notifications: [notification] }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ entries: [ledgerEntry], nextCursor: null }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  };
  const result = await verifySubscriptionReminderOutcome({
    baseUrl, workspaceId, cookie, periodEnd, reminderDays: "7", fetchImpl
  });
  assert.deepEqual(result, { notifications: 1, ledgerEntries: 1, reminderDays: 7 });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.headers.Cookie, cookie);
  assert.equal(calls[0].url.searchParams.get("category"), "Workspace & Billing");
  assert.equal(calls[1].url.searchParams.get("category"), "billing");
});

test("acceptance fails when a notification has no matching idempotent ledger event", async () => {
  const fetchImpl = async (url) => {
    if (new URL(url).pathname.endsWith("/notifications")) {
      return new Response(JSON.stringify({ notifications: [notification] }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ entries: [], nextCursor: null }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  };
  await assert.rejects(
    verifySubscriptionReminderOutcome({ baseUrl, workspaceId, cookie, periodEnd, reminderDays: "7", fetchImpl }),
    /ledger_count_mismatch/
  );
});

test("acceptance rejects duplicate reminders rather than masking replay defects", async () => {
  const fetchImpl = async (url) => {
    if (new URL(url).pathname.endsWith("/notifications")) {
      return new Response(JSON.stringify({ notifications: [notification, notification] }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }
    return new Response(JSON.stringify({ entries: [ledgerEntry], nextCursor: null }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  };
  await assert.rejects(
    verifySubscriptionReminderOutcome({ baseUrl, workspaceId, cookie, periodEnd, reminderDays: "7", fetchImpl }),
    /notification_count_mismatch/
  );
});

test("acceptance follows the ledger cursor until the matching reminder appears", async () => {
  let ledgerPage = 0;
  const fetchImpl = async (url) => {
    if (new URL(url).pathname.endsWith("/notifications")) {
      return new Response(JSON.stringify({ notifications: [notification] }), {
        status: 200, headers: { "content-type": "application/json" }
      });
    }
    ledgerPage += 1;
    return ledgerPage === 1
      ? new Response(JSON.stringify({ entries: [], nextCursor: "next-page" }), {
          status: 200, headers: { "content-type": "application/json" }
        })
      : new Response(JSON.stringify({ entries: [ledgerEntry], nextCursor: null }), {
          status: 200, headers: { "content-type": "application/json" }
        });
  };
  await verifySubscriptionReminderOutcome({ baseUrl, workspaceId, cookie, periodEnd, reminderDays: "7", fetchImpl });
  assert.equal(ledgerPage, 2);
});

test("acceptance requires canonical inputs and HTTPS for hosted checks", async () => {
  await assert.rejects(
    verifySubscriptionReminderOutcome({
      baseUrl: "http://paylore.example", workspaceId, cookie, periodEnd, reminderDays: "7"
    }),
    /must use HTTPS/
  );
  await assert.rejects(
    verifySubscriptionReminderOutcome({
      baseUrl, workspaceId, cookie, periodEnd, reminderDays: "8", fetchImpl: async () => { throw new Error("should not fetch"); }
    }),
    /must be 1 or 7/
  );
});
