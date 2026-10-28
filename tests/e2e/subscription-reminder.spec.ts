import { expect, test } from "@playwright/test";

const baseUrl = process.env.PAYLORE_SUBSCRIPTION_REMINDER_ACCEPTANCE_BASE_URL;
const workspaceId = process.env.PAYLORE_SUBSCRIPTION_REMINDER_ACCEPTANCE_WORKSPACE_ID;
const cookie = process.env.PAYLORE_SUBSCRIPTION_REMINDER_ACCEPTANCE_COOKIE;
const periodEndText = process.env.PAYLORE_SUBSCRIPTION_REMINDER_ACCEPTANCE_PERIOD_END;
const reminderDaysText = process.env.PAYLORE_SUBSCRIPTION_REMINDER_ACCEPTANCE_DAYS;

test("scheduled reminder is visible with exactly one matching billing-ledger outcome", async ({ request }) => {
  test.skip(
    !baseUrl || !workspaceId || !cookie || !periodEndText || !reminderDaysText,
    "Set the subscription-reminder acceptance environment locally to run this hosted workflow check."
  );
  expect(["1", "7"]).toContain(reminderDaysText);
  const base = new URL(baseUrl!);
  expect(["https:", ...(base.hostname === "localhost" || base.hostname === "127.0.0.1" ? ["http:"] : [])])
    .toContain(base.protocol);
  const periodEnd = new Date(periodEndText!);
  expect(Number.isFinite(periodEnd.getTime())).toBe(true);
  expect(periodEnd.toISOString()).toBe(periodEndText);
  const reminderDays = Number(reminderDaysText);
  const eventKey = `subscription-renewal-reminder:${periodEnd.getTime()}:${reminderDays}`;
  const notificationsUrl = new URL(
    `/api/workspaces/${encodeURIComponent(workspaceId!)}/notifications`,
    base
  );
  notificationsUrl.searchParams.set("category", "Workspace & Billing");
  const notificationResponse = await request.get(notificationsUrl.toString(), {
    headers: { Cookie: cookie! }
  });
  expect(notificationResponse.ok()).toBe(true);
  const notificationPayload = await notificationResponse.json();
  expect(Array.isArray(notificationPayload.notifications)).toBe(true);
  const notifications = notificationPayload.notifications.filter((item: any) => item?.eventKey === eventKey);
  expect(notifications).toHaveLength(1);
  expect(notifications[0]).toMatchObject({
    category: "Workspace & Billing",
    title: "Subscription expires soon"
  });
  expect(notifications[0].destination).toBe(`/workspace/${workspaceId}/billing`);
  const notificationCountdown = String(notifications[0].body).match(/ends in ([1-7]) days?/);
  expect(notificationCountdown).not.toBeNull();
  const daysRemaining = Number(notificationCountdown![1]);
  expect(daysRemaining).toBeGreaterThanOrEqual(reminderDays === 1 ? 1 : 2);
  expect(daysRemaining).toBeLessThanOrEqual(reminderDays);

  const ledgerUrl = new URL(`/api/workspaces/${encodeURIComponent(workspaceId!)}/ledger`, base);
  ledgerUrl.searchParams.set("category", "billing");
  ledgerUrl.searchParams.set("limit", "100");
  const ledgerEntries: any[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let foundEnd = false;
  for (let pageNumber = 0; pageNumber < 25; pageNumber += 1) {
    const pageUrl = new URL(ledgerUrl);
    if (cursor) pageUrl.searchParams.set("cursor", cursor);
    const response = await request.get(pageUrl.toString(), { headers: { Cookie: cookie! } });
    expect(response.ok()).toBe(true);
    const payload = await response.json();
    expect(Array.isArray(payload.entries)).toBe(true);
    ledgerEntries.push(...payload.entries.filter((entry: any) => entry?.idempotencyKey === eventKey));
    if (payload.nextCursor === null || payload.nextCursor === undefined) {
      foundEnd = true;
      break;
    }
    expect(typeof payload.nextCursor).toBe("string");
    expect(cursors.has(payload.nextCursor)).toBe(false);
    cursors.add(payload.nextCursor);
    cursor = payload.nextCursor;
  }
  expect(foundEnd).toBe(true);
  expect(ledgerEntries).toHaveLength(1);
  expect(ledgerEntries[0]).toMatchObject({
    category: "billing",
    entryType: "subscription_renewal_reminder",
    status: "finalized",
    amountBaseUnits: null,
    mint: null,
    transactionSignature: null,
    referenceType: "workspace_subscription",
    metadata: {
      financial: false,
      periodEnd: periodEndText,
      reminderDays,
      cancellationScheduled: expect.any(Boolean)
    }
  });
});
