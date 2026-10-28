export type PayrollRecoveryQueueState = "eligible" | "reconcile" | "ineligible";

export type PayrollRecoveryEligibilityInput = {
  claimState: string;
  claimAddress: string | null;
  escrowStatus: string | null;
};

export type PayrollRecoveryEligibility = {
  state: PayrollRecoveryQueueState;
  label: string;
};

export function assessPayrollRecoveryEligibility(
  input: PayrollRecoveryEligibilityInput
): PayrollRecoveryEligibility {
  if (input.claimState === "claimed") {
    return { state: "ineligible", label: "Claimed — not recoverable" };
  }
  if (input.claimState === "recovered") {
    return { state: "ineligible", label: "Already recovered" };
  }
  if (input.claimState === "settlement_pending") {
    return { state: "ineligible", label: "Claim settlement in progress" };
  }
  if (
    input.claimState === "recovery_pending" &&
    input.escrowStatus === "recovery_pending"
  ) {
    return { state: "reconcile", label: "Recovery in progress — reconcile status" };
  }
  if (input.claimState !== "unclaimed") {
    return { state: "ineligible", label: "State requires review" };
  }
  if (!input.claimAddress) {
    return { state: "ineligible", label: "Claim PDA not created" };
  }
  if (input.escrowStatus !== "funded") {
    return { state: "ineligible", label: "Claim escrow is not funded" };
  }
  return { state: "eligible", label: "Eligible for recovery" };
}
