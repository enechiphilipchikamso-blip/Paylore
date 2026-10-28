import { describe, expect, it } from "vitest";
import {
  getDueSubscriptionRenewalReminderDays,
  getSubscriptionDaysRemaining
} from "./retention-policy";

const dayMs = 24 * 60 * 60 * 1000;
const now = new Date("2026-10-24T08:00:00.000Z");

describe("subscription renewal reminder milestone windows", () => {
  it("keeps the seven-day key retryable throughout its due window", () => {
    expect(getSubscriptionDaysRemaining(new Date(now.getTime() + 8 * dayMs), now)).toBe(8);
    expect(getDueSubscriptionRenewalReminderDays(new Date(now.getTime() + 8 * dayMs), now)).toEqual([]);
    expect(getSubscriptionDaysRemaining(new Date(now.getTime() + 7 * dayMs), now)).toBe(7);
    expect(getDueSubscriptionRenewalReminderDays(new Date(now.getTime() + 7 * dayMs), now)).toEqual([7]);
    expect(getSubscriptionDaysRemaining(new Date(now.getTime() + 6 * dayMs), now)).toBe(6);
    expect(getDueSubscriptionRenewalReminderDays(new Date(now.getTime() + 6 * dayMs), now)).toEqual([7]);
    expect(getDueSubscriptionRenewalReminderDays(new Date(now.getTime() + 2 * dayMs), now)).toEqual([7]);
  });

  it("reserves the one-day key for the final 24 hours and rejects invalid or expired periods", () => {
    expect(getSubscriptionDaysRemaining(new Date(now.getTime() + dayMs), now)).toBe(1);
    expect(getDueSubscriptionRenewalReminderDays(new Date(now.getTime() + dayMs), now)).toEqual([1]);
    expect(getSubscriptionDaysRemaining(new Date(now.getTime() + 1), now)).toBe(1);
    expect(getDueSubscriptionRenewalReminderDays(new Date(now.getTime() + 1), now)).toEqual([1]);
    expect(getSubscriptionDaysRemaining(new Date(now.getTime()), now)).toBeNull();
    expect(getDueSubscriptionRenewalReminderDays(new Date(Number.NaN), now)).toEqual([]);
  });
});
