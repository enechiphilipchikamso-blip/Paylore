import { describe, expect, it } from "vitest";
import { canTransitionSubscriptionPaymentAttemptStatus as canTransition } from "./subscription-payment-attempt-policy";

describe("subscription payment attempt state transitions", () => {
  it.each([
    ["prepared", null, "expired", null, true],
    ["prepared", null, "failed", null, true],
    ["submitted", "signature-a", "confirmed", "signature-a", true],
    ["submitted", "signature-a", "failed", "signature-a", true],
    ["confirmed", "signature-a", "confirmed", "signature-a", true],
    ["expired", null, "expired", null, true],
    ["failed", "signature-a", "failed", "signature-a", true]
  ] as const)("permits safe or idempotent transition %s → %s", (currentStatus, currentSignature, nextStatus, nextSignature, expected) => {
    expect(canTransition({
      currentStatus,
      currentSignature,
      nextStatus,
      nextSignature
    })).toBe(expected);
  });

  it.each([
    ["confirmed", "signature-a", "failed", "signature-a"],
    ["expired", null, "confirmed", "signature-a"],
    ["failed", "signature-a", "expired", null],
    ["prepared", null, "confirmed", "signature-a"],
    ["submitted", "signature-a", "expired", null],
    ["submitted", "signature-a", "confirmed", "signature-b"],
    ["submitted", null, "failed", null],
    ["prepared", "signature-a", "failed", "signature-a"]
  ] as const)("rejects illegal or conflicting transition %s → %s", (currentStatus, currentSignature, nextStatus, nextSignature) => {
    expect(canTransition({
      currentStatus,
      currentSignature,
      nextStatus,
      nextSignature
    })).toBe(false);
  });
});
