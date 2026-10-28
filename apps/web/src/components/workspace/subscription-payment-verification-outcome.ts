export type SubscriptionPaymentVerificationOutcome =
  | "active"
  | "pending"
  | "failed"
  | "unavailable";

export function classifySubscriptionPaymentVerificationResponse(input: {
  ok: boolean;
  status: number;
  hasAttempt: boolean;
  body: { status?: string; error?: string } | null;
}): SubscriptionPaymentVerificationOutcome {
  if (input.ok && (!input.hasAttempt || input.body?.status === "active")) {
    return "active";
  }
  if (input.status === 202 || input.body?.status === "reconciliation_required") {
    return "pending";
  }
  if (
    input.status === 422 ||
    input.body?.error === "payment_attempt_mismatch" ||
    input.body?.error === "payment_could_not_be_verified"
  ) {
    return "failed";
  }
  return "unavailable";
}
