import { describe, expect, it } from "vitest";
import { getDueSubscriptionRenewalReminderDays } from "./retention-policy";

const dayMs = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-24T08:00:00.000Z");

describe("subscription renewal reminder milestone windows", () => {
  it("emits a seven-day reminder only while the truthful rounded-up countdown is seven days", () => {
    expect(getDueSubscriptionRenewalReminderDays(new Date(now.getTime() + 7 * dayMs), now)).toEqual([7]);
    expect(getDueSubscriptionRenewalReminderDays(new Date(now.getTime() + 6 * dayMs + 1), now)).toEqual([7]);
    expect(getDueSubscriptionRenewalReminderDays(new Date(now.getTime() + 6 * dayMs), now)).toEqual([]);
    expect(getDueSubscriptionRenewalReminderDays(new Date(now.getTime() + 2 * dayMs), now)).toEqual([]);
  });

  it("emits the one-day milestone only in its 24-hour countdown window", () => {
    expect(getDueSubscriptionRenewalReminderDays(new Date(now.getTime() + dayMs), now)).toEqual([1]);
    expect(getDueSubscriptionRenewalReminderDays(new Date(now.getTime() + 1), now)).toEqual([1]);
    expect(getDueSubscriptionRenewalReminderDays(new Date(now.getTime() + dayMs + 1), now)).toEqual([]);
    expect(getDueSubscriptionRenewalReminderDays(new Date(now.getTime()), now)).toEqual([]);
    expect(getDueSubscriptionRenewalReminderDays(new Date(Number.NaN), now)).toEqual([]);
  });
});
