export type ClaimAndCashOutOutcome = {
  state: "success" | "error" | "partial";
  text: string;
};

export function getClaimAndCashOutOutcome(input: {
  settled: number;
  pending: number;
  failed: number;
  cleanupPending: number;
  stateConflict: boolean;
  /** Human-readable reason for the first failed allocation, when the server reported one. */
  failureReason?: string | null;
  pendingReason?: string | null;
}): ClaimAndCashOutOutcome {
  if (input.stateConflict) {
    return {
      state: input.settled ? "partial" : "error",
      text: "The finalized Claim PDA is no longer UNCLAIMED. No second transfer was attempted; this allocation needs administrator reconciliation before retry."
    };
  }
  if (input.failed) {
    return {
      state: input.settled ? "partial" : "error",
      text: `${input.settled} allocation(s) settled; ${input.failed} need attention. Unverified transfers are not shown as complete.` +
        (input.failureReason ? ` Reason: ${input.failureReason}` : "") +
        (input.pending ? ` ${input.pending} more await finality or retry; check them before claiming again.` : "")
    };
  }
  if (input.pending || input.cleanupPending) {
    return {
      state: "partial",
      text: `${input.settled} allocation(s) settled; ${input.pending} await finality or retry, and ${input.cleanupPending} need proof-context cleanup.` +
        (input.pendingReason ? ` Reason: ${input.pendingReason}` : "")
    };
  }
  return {
    state: "success",
    text: `${input.settled} confidential payroll allocation(s) transferred and reconciled. Apply pending credits before withdrawing; public cash-out is a separate action.`
  };
}

/**
 * What a contributor is told when a claim did not settle but nothing is wrong on their side.
 * Each text says whether funds moved and what the next Claim does, so "pending" is never
 * left unexplained and a rolled-back claim is never presented as a stuck transfer.
 */
export function describeContributorClaimPending(status: string, stage?: unknown): string | null {
  if (status === "retry_ready") {
    return "This settlement did not complete and no payout reached your account. Select Claim again.";
  }
  switch (stage) {
    case "rollback_cleanup_pending":
    case "rollback_release_pending":
      return "This settlement was rolled back and nothing was transferred. Paylore is finishing the cleanup; select Claim again in a moment.";
    case "proof_setup_unconfirmed":
      return "The settlement proofs are awaiting network confirmation. Nothing has been transferred yet; select Claim again shortly.";
    case "transfer_unconfirmed":
    case "transfer_outcome_unknown":
    case "balances_unverified":
      return "A transfer for this settlement is awaiting network finality. Do not start another payout; select Claim again shortly and Paylore verifies it.";
    case "proof_cleanup_pending":
    case "lock_release_pending":
      return "The funds for this settlement have moved and Paylore is finishing the final cleanup. Select Claim again shortly.";
    case "claim_settlement_in_progress":
    case "funding_in_progress":
      return "Another settlement for this allocation is still running. Select Claim again in a minute.";
    default:
      return null;
  }
}
