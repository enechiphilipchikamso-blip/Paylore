import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const REMINDER_CATEGORY = "Workspace & Billing";
const LEDGER_CATEGORY = "billing";
const PAGE_LIMIT = 100;
const MAX_LEDGER_PAGES = 25;

async function readJson(fetchImpl, url, cookie, label) {
  const response = await fetchImpl(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Cookie: cookie
    },
    cache: "no-store",
    redirect: "error"
  });
  if (!response.ok) {
    throw new Error(`${label}_http_${response.status}`);
  }
  try {
    return await response.json();
  } catch {
    throw new Error(`${label}_invalid_json`);
  }
}

function requireInputs(input) {
  if (
    typeof input.baseUrl !== "string" ||
    typeof input.workspaceId !== "string" ||
    input.workspaceId.trim() === "" ||
    typeof input.cookie !== "string" ||
    input.cookie.trim() === "" ||
    typeof input.periodEnd !== "string" ||
    typeof input.reminderDays !== "string"
  ) {
    throw new Error(
      "Set PAYLORE_SUBSCRIPTION_REMINDER_ACCEPTANCE_BASE_URL, PAYLORE_SUBSCRIPTION_REMINDER_ACCEPTANCE_WORKSPACE_ID, PAYLORE_SUBSCRIPTION_REMINDER_ACCEPTANCE_COOKIE, PAYLORE_SUBSCRIPTION_REMINDER_ACCEPTANCE_PERIOD_END, and PAYLORE_SUBSCRIPTION_REMINDER_ACCEPTANCE_DAYS."
    );
  }
  if (input.reminderDays !== "1" && input.reminderDays !== "7") {
    throw new Error("PAYLORE_SUBSCRIPTION_REMINDER_ACCEPTANCE_DAYS must be 1 or 7.");
  }
  const periodEnd = new Date(input.periodEnd);
  if (!Number.isFinite(periodEnd.getTime()) || periodEnd.toISOString() !== input.periodEnd) {
    throw new Error("PAYLORE_SUBSCRIPTION_REMINDER_ACCEPTANCE_PERIOD_END must be a canonical ISO 8601 timestamp.");
  }
  const baseUrl = new URL(input.baseUrl);
  if (
    baseUrl.protocol !== "https:" &&
    !(baseUrl.protocol === "http:" && ["localhost", "127.0.0.1"].includes(baseUrl.hostname))
  ) {
    throw new Error("The subscription reminder acceptance URL must use HTTPS except on localhost.");
  }
  return { baseUrl, periodEnd, reminderDays: Number(input.reminderDays) };
}

function requireOneMatchingNotification(notifications, eventKey, reminderDays) {
  if (!Array.isArray(notifications)) {
    throw new Error("subscription_reminder_notification_response_invalid");
  }
  const matches = notifications.filter((item) => item?.eventKey === eventKey);
  if (matches.length !== 1) {
    throw new Error("subscription_reminder_notification_count_mismatch");
  }
  const notification = matches[0];
  const countdown = typeof notification.body === "string"
    ? notification.body.match(/ends in ([1-7]) days?/)
    : null;
  const daysRemaining = countdown ? Number(countdown[1]) : null;
  const minimumDays = reminderDays === 1 ? 1 : 2;
  if (
    notification.category !== REMINDER_CATEGORY ||
    notification.title !== "Subscription expires soon" ||
    daysRemaining === null ||
    daysRemaining < minimumDays ||
    daysRemaining > reminderDays ||
    (reminderDays === 1 && daysRemaining !== 1) ||
    typeof notification.destination !== "string" ||
    !notification.destination.endsWith("/billing")
  ) {
    throw new Error("subscription_reminder_notification_content_mismatch");
  }
  return notification;
}

async function findLedgerMatches(fetchImpl, baseUrl, workspaceId, cookie, eventKey) {
  const url = new URL(`/api/workspaces/${encodeURIComponent(workspaceId)}/ledger`, baseUrl);
  url.searchParams.set("category", LEDGER_CATEGORY);
  url.searchParams.set("limit", String(PAGE_LIMIT));
  const matches = [];
  const seenCursors = new Set();
  let cursor;
  for (let pageNumber = 0; pageNumber < MAX_LEDGER_PAGES; pageNumber += 1) {
    const pageUrl = new URL(url);
    if (cursor) pageUrl.searchParams.set("cursor", cursor);
    const payload = await readJson(fetchImpl, pageUrl, cookie, "subscription_reminder_ledger");
    if (!Array.isArray(payload.entries)) {
      throw new Error("subscription_reminder_ledger_response_invalid");
    }
    matches.push(...payload.entries.filter((item) => item?.idempotencyKey === eventKey));
    if (payload.nextCursor === null || payload.nextCursor === undefined) return matches;
    if (typeof payload.nextCursor !== "string" || seenCursors.has(payload.nextCursor)) {
      throw new Error("subscription_reminder_ledger_cursor_invalid");
    }
    seenCursors.add(payload.nextCursor);
    cursor = payload.nextCursor;
  }
  throw new Error("subscription_reminder_ledger_scan_limit_exceeded");
}

function requireOneMatchingLedgerEntry(entries, eventKey, periodEnd, reminderDays) {
  if (entries.length !== 1) {
    throw new Error("subscription_reminder_ledger_count_mismatch");
  }
  const entry = entries[0];
  if (
    entry.category !== LEDGER_CATEGORY ||
    entry.entryType !== "subscription_renewal_reminder" ||
    entry.status !== "finalized" ||
    entry.amountBaseUnits !== null ||
    entry.mint !== null ||
    entry.transactionSignature !== null ||
    entry.referenceType !== "workspace_subscription" ||
    typeof entry.metadata !== "object" ||
    entry.metadata === null ||
    entry.metadata.financial !== false ||
    entry.metadata.periodEnd !== periodEnd.toISOString() ||
    entry.metadata.reminderDays !== reminderDays ||
    typeof entry.metadata.cancellationScheduled !== "boolean"
  ) {
    throw new Error("subscription_reminder_ledger_content_mismatch");
  }
  return entry;
}

/** Confirms the actual persisted notification and idempotent non-financial ledger outcome for one recipient. */
export async function verifySubscriptionReminderOutcome({
  baseUrl,
  workspaceId,
  cookie,
  periodEnd: periodEndText,
  reminderDays: reminderDaysText,
  fetchImpl = fetch
}) {
  const { baseUrl: base, periodEnd, reminderDays } = requireInputs({
    baseUrl,
    workspaceId,
    cookie,
    periodEnd: periodEndText,
    reminderDays: reminderDaysText
  });
  const eventKey = `subscription-renewal-reminder:${periodEnd.getTime()}:${reminderDays}`;
  const notificationsUrl = new URL(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/notifications`,
    base
  );
  notificationsUrl.searchParams.set("category", REMINDER_CATEGORY);
  const notificationPayload = await readJson(
    fetchImpl,
    notificationsUrl,
    cookie,
    "subscription_reminder_notifications"
  );
  requireOneMatchingNotification(notificationPayload.notifications, eventKey, reminderDays);
  const ledgerEntries = await findLedgerMatches(
    fetchImpl,
    base,
    workspaceId,
    cookie,
    eventKey
  );
  requireOneMatchingLedgerEntry(ledgerEntries, eventKey, periodEnd, reminderDays);
  return { notifications: 1, ledgerEntries: 1, reminderDays };
}
async function main() {
  const result = await verifySubscriptionReminderOutcome({
    baseUrl: process.env.PAYLORE_SUBSCRIPTION_REMINDER_ACCEPTANCE_BASE_URL,
    workspaceId: process.env.PAYLORE_SUBSCRIPTION_REMINDER_ACCEPTANCE_WORKSPACE_ID,
    cookie: process.env.PAYLORE_SUBSCRIPTION_REMINDER_ACCEPTANCE_COOKIE,
    periodEnd: process.env.PAYLORE_SUBSCRIPTION_REMINDER_ACCEPTANCE_PERIOD_END,
    reminderDays: process.env.PAYLORE_SUBSCRIPTION_REMINDER_ACCEPTANCE_DAYS
  });
  process.stdout.write(
    `Subscription reminder acceptance verified: ${result.notifications} notification and ${result.ledgerEntries} non-financial billing-ledger event match the same reminder key.\n`
  );
}

if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(
      `Subscription reminder acceptance failed: ${error instanceof Error ? error.message : "unknown_error"}\n`
    );
    process.exitCode = 1;
  });
}
