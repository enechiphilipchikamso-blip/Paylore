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
        (input.failureReason ? ` Reason: ${input.failureReason}` : "")
    };
  }
  if (input.pending || input.cleanupPending) {
    return {
      state: "partial",
      text: `${input.settled} allocation(s) settled; ${input.pending} await finality or retry, and ${input.cleanupPending} need proof-context cleanup.`
    };
  }
  return {
    state: "success",
    text: `${input.settled} confidential payroll allocation(s) transferred and reconciled. Apply pending credits before withdrawing; public cash-out is a separate action.`
  };
}
