export type SubscriptionPaymentAttemptStatus =
  | "prepared"
  | "submitted"
  | "confirmed"
  | "expired"
  | "failed";

export type TerminalPaymentAttemptStatus = "confirmed" | "expired" | "failed";

/** Terminal outcomes cannot overwrite one another; a submitted attempt can only resolve against its recorded signature. */
export function canTransitionSubscriptionPaymentAttemptStatus(input: {
  currentStatus: SubscriptionPaymentAttemptStatus;
  currentSignature: string | null;
  nextStatus: TerminalPaymentAttemptStatus;
  nextSignature: string | null;
}): boolean {
  if (input.currentStatus === input.nextStatus) {
    return input.currentSignature === input.nextSignature;
  }

  if (input.currentStatus === "prepared") {
    return input.currentSignature === null &&
      (input.nextStatus === "expired" || input.nextStatus === "failed") &&
      input.nextSignature === null;
  }

  if (input.currentStatus === "submitted") {
    return input.currentSignature !== null &&
      (input.nextStatus === "confirmed" || input.nextStatus === "failed") &&
      input.nextSignature === input.currentSignature;
  }

  return false;
}
