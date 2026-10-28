import { describe, expect, it } from "vitest";
import { classifySubscriptionPaymentVerificationResponse } from "./subscription-payment-verification-outcome";

describe("subscription payment verification response policy", () => {
  it("accepts only a successful response with the active state for attempt-backed payments", () => {
    expect(classifySubscriptionPaymentVerificationResponse({
      ok: true, status: 200, hasAttempt: true, body: { status: "active" }
    })).toBe("active");
    expect(classifySubscriptionPaymentVerificationResponse({
      ok: true, status: 200, hasAttempt: true, body: { status: "prepared" }
    })).toBe("unavailable");
  });

  it("keeps a not-yet-finalized transaction pending without enabling another payment", () => {
    expect(classifySubscriptionPaymentVerificationResponse({
      ok: false, status: 202, hasAttempt: true, body: { status: "reconciliation_required" }
    })).toBe("pending");
    expect(classifySubscriptionPaymentVerificationResponse({
      ok: true, status: 200, hasAttempt: true, body: { status: "reconciliation_required" }
    })).toBe("pending");
  });

  it("distinguishes a verified payment failure from a provider or transport outage", () => {
    expect(classifySubscriptionPaymentVerificationResponse({
      ok: false, status: 422, hasAttempt: true, body: { error: "payment_could_not_be_verified" }
    })).toBe("failed");
    expect(classifySubscriptionPaymentVerificationResponse({
      ok: false, status: 503, hasAttempt: true, body: { error: "payment_configuration_incomplete" }
    })).toBe("unavailable");
    expect(classifySubscriptionPaymentVerificationResponse({
      ok: false, status: 500, hasAttempt: true, body: null
    })).toBe("unavailable");
  });

  it("preserves successful legacy renewal verification only when the server response is successful", () => {
    expect(classifySubscriptionPaymentVerificationResponse({
      ok: true, status: 200, hasAttempt: false, body: null
    })).toBe("active");
    expect(classifySubscriptionPaymentVerificationResponse({
      ok: false, status: 500, hasAttempt: false, body: null
    })).toBe("unavailable");
  });
});
