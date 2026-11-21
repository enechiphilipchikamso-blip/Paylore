export type PayrollRecoveryQueueState = "eligible" | "reconcile" | "funding_hold" | "ineligible";

export type PayrollRecoveryEligibilityInput = {
  claimState: string;
  claimAddress: string | null;
  escrowStatus: string | null;
  /** Recorded only once a contributor claim has submitted its settlement transaction. */
  settlementSignature?: string | null;
};

/**
 * Claim escrow funding holds the allocation in settlement_pending for the whole attempt.
 * That hold is not a contributor claim: no settlement transaction is recorded and the
 * escrow is still in a funding state. A Check funding action verifies or rolls it back.
 */
export function isPayrollFundingHold(input: {
  claimState: string;
  escrowStatus: string | null;
  settlementSignature?: string | null;
}): boolean {
  return input.claimState === "settlement_pending" &&
    !input.settlementSignature &&
    (input.escrowStatus === "ready" || input.escrowStatus === "funding" || input.escrowStatus === "funded");
}

/** Why an allocation is held by Claim escrow funding, in terms of what is recorded for it. */
export function describePayrollFundingHold(input: {
  escrowStatus: string | null;
  fundingSignature?: string | null;
  /** True when the hold is older than a funding request can still be running. */
  stale: boolean;
}): string {
  if (input.escrowStatus === "funded") {
    return "The claim escrow is funded, but the hold that Paylore placed on this allocation while funding was not released. Check funding verifies the funding and releases the hold.";
  }
  if (input.escrowStatus === "ready") {
    return "A funding attempt stopped before it released this allocation and no transfer was recorded, so no funds moved. Check funding releases the hold so funding can be started again.";
  }
  if (input.fundingSignature) {
    return "A funding transfer was submitted and its result is not verified yet. Check funding confirms it on-chain, records it and releases the hold; do not start another transfer.";
  }
  return input.stale
    ? "A funding attempt started, recorded no transfer and has stopped. Check funding rolls it back and releases the hold; no funds moved."
    : "A funding request for this allocation started moments ago and may still be running. Check funding again shortly; it rolls back or completes the attempt as soon as it is no longer running.";
}

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
  if (isPayrollFundingHold(input)) {
    return { state: "funding_hold", label: "Claim escrow funding hold — check funding" };
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

/** One-line summary of what the Recovery queue currently holds, from the recorded eligibility of each row. */
export function summarizePayrollRecoveryQueue(items: ReadonlyArray<PayrollRecoveryEligibility>): string {
  if (items.length === 0) return "No allocations are unclaimed or held by escrow funding.";
  const count = (state: PayrollRecoveryQueueState) => items.filter((item) => item.state === state).length;
  const parts: string[] = [];
  const eligible = count("eligible");
  const hold = count("funding_hold");
  const reconcile = count("reconcile");
  const waiting = count("ineligible");
  if (eligible) parts.push(`${eligible} eligible for recovery`);
  if (hold) parts.push(`${hold} held by escrow funding — check funding to verify or release`);
  if (reconcile) parts.push(`${reconcile} with a recovery to reconcile`);
  if (waiting) parts.push(`${waiting} not eligible yet — the reason is shown on each row`);
  return `${items.length} ${items.length === 1 ? "allocation" : "allocations"}: ${parts.join("; ")}.`;
}
