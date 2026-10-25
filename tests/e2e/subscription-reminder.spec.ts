import { expect, test } from "@playwright/test";
import { verifySubscriptionReminderOutcome } from "../../scripts/verify-subscription-reminder-acceptance.mjs";

const baseUrl = process.env.PAYLORE_SUBSCRIPTION_REMINDER_ACCEPTANCE_BASE_URL;
const workspaceId = process.env.PAYLORE_SUBSCRIPTION_REMINDER_ACCEPTANCE_WORKSPACE_ID;
const cookie = process.env.PAYLORE_SUBSCRIPTION_REMINDER_ACCEPTANCE_COOKIE;
const periodEnd = process.env.PAYLORE_SUBSCRIPTION_REMINDER_ACCEPTANCE_PERIOD_END;
const reminderDays = process.env.PAYLORE_SUBSCRIPTION_REMINDER_ACCEPTANCE_DAYS;

test("scheduled reminder is visible with exactly one matching billing-ledger outcome", async () => {
  test.skip(
    !baseUrl || !workspaceId || !cookie || !periodEnd || !reminderDays,
    "Set the subscription-reminder acceptance environment locally to run this hosted workflow check."
  );

  const result = await verifySubscriptionReminderOutcome({
    baseUrl,
    workspaceId,
    cookie,
    periodEnd,
    reminderDays
  });
  expect(result).toEqual({
    notifications: 1,
    ledgerEntries: 1,
    reminderDays: Number(reminderDays)
  });
});
