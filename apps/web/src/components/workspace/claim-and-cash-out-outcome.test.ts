import { describe, expect, it } from "vitest";
import { describeContributorClaimPending, getClaimAndCashOutOutcome } from "./claim-and-cash-out-outcome";

describe("Claim & Cash Out outcome copy", () => {
  it("reports success only for fully reconciled allocations", () => {
    expect(getClaimAndCashOutOutcome({
      settled: 2, pending: 0, failed: 0, cleanupPending: 0, stateConflict: false
    })).toEqual({
      state: "success",
      text: "2 confidential payroll allocation(s) transferred and reconciled. Apply pending credits before withdrawing; public cash-out is a separate action."
    });
  });

  it("does not describe a state conflict as paid and explains retry is unsafe", () => {
    expect(getClaimAndCashOutOutcome({
      settled: 0, pending: 0, failed: 0, cleanupPending: 0, stateConflict: true
    })).toMatchObject({
      state: "error",
      text: expect.stringContaining("No second transfer was attempted")
    });
  });

  it("distinguishes partial completion from an entirely failed run", () => {
    expect(getClaimAndCashOutOutcome({
      settled: 1, pending: 0, failed: 1, cleanupPending: 0, stateConflict: false
    })).toMatchObject({ state: "partial", text: expect.stringContaining("1 allocation(s) settled; 1 need attention.") });
    expect(getClaimAndCashOutOutcome({
      settled: 0, pending: 0, failed: 1, cleanupPending: 0, stateConflict: false
    })).toMatchObject({ state: "error" });
  });

  it("still reports allocations awaiting finality when others failed", () => {
    expect(getClaimAndCashOutOutcome({
      settled: 0, pending: 2, failed: 1, cleanupPending: 0, stateConflict: false,
      failureReason: "The Gas Tank needs SOL."
    })).toMatchObject({
      state: "error",
      text: expect.stringContaining("2 more await finality or retry")
    });
  });

  it("keeps finality and proof-context cleanup pending separate from success", () => {
    expect(getClaimAndCashOutOutcome({
      settled: 1, pending: 2, failed: 0, cleanupPending: 1, stateConflict: false
    })).toEqual({
      state: "partial",
      text: "1 allocation(s) settled; 2 await finality or retry, and 1 need proof-context cleanup."
    });
  });

  it("includes the request failure reason when claim finality is unknown", () => {
    expect(getClaimAndCashOutOutcome({
      settled: 0,
      pending: 1,
      failed: 0,
      cleanupPending: 0,
      stateConflict: false,
      pendingReason: "Payroll claim failed: RPC request timed out"
    })).toMatchObject({
      state: "partial",
      text: expect.stringContaining("Reason: Payroll claim failed: RPC request timed out")
    });
  });
});

describe("describeContributorClaimPending", () => {
  it("tells the contributor a rolled-back claim moved no funds and can simply be retried", () => {
    expect(describeContributorClaimPending("retry_ready")).toContain("no payout reached your account");
    for (const stage of ["rollback_cleanup_pending", "rollback_release_pending"]) {
      const text = describeContributorClaimPending("pending", stage) ?? "";
      expect(text).toContain("rolled back");
      expect(text).toContain("select Claim again");
      expect(text).not.toMatch(/funded|finality/i);
    }
  });

  it("warns against a second payout only when a transfer may be on the network", () => {
    for (const stage of ["transfer_unconfirmed", "transfer_outcome_unknown", "balances_unverified"]) {
      expect(describeContributorClaimPending("pending", stage)).toContain("Do not start another payout");
    }
    expect(describeContributorClaimPending("pending", "proof_setup_unconfirmed")).toContain("Nothing has been transferred yet");
  });

  it("explains a funded escrow with unfinished cleanup and a concurrent settlement", () => {
    expect(describeContributorClaimPending("pending", "proof_cleanup_pending")).toContain("final cleanup");
    expect(describeContributorClaimPending("pending", "funding_in_progress")).toContain("still running");
  });

  it("gives no reason when the server named none", () => {
    expect(describeContributorClaimPending("pending")).toBeNull();
    expect(describeContributorClaimPending("pending", "something_new")).toBeNull();
  });

  it("feeds the outcome text for a pending claim", () => {
    const outcome = getClaimAndCashOutOutcome({
      settled: 0, pending: 1, failed: 0, cleanupPending: 0, stateConflict: false,
      pendingReason: describeContributorClaimPending("retry_ready")
    });
    expect(outcome.state).toBe("partial");
    expect(outcome.text).toContain("Select Claim again.");
  });
});
