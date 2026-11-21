import { describe, expect, it } from "vitest";
import { assessPayrollRecoveryEligibility, describePayrollFundingHold, isPayrollFundingHold, summarizePayrollRecoveryQueue } from "./payroll-recovery-queue-policy";

describe("payroll recovery queue eligibility", () => {
  const eligible = {
    claimState: "unclaimed",
    claimAddress: "ClaimPda111",
    escrowStatus: "funded"
  };

  it("only marks a funded unclaimed allocation with a Claim PDA as eligible", () => {
    expect(assessPayrollRecoveryEligibility(eligible)).toEqual({
      state: "eligible",
      label: "Eligible for recovery"
    });
  });

  it.each([
    ["claimed", "funded", "Claimed — not recoverable"],
    ["recovered", "recovered", "Already recovered"],
    ["settlement_pending", "settlement_pending", "Claim settlement in progress"],
    ["cancelled", null, "State requires review"]
  ])("denies recovery when Claim PDA state is %s", (claimState, escrowStatus, label) => {
    expect(assessPayrollRecoveryEligibility({
      ...eligible,
      claimState,
      escrowStatus
    })).toMatchObject({ state: "ineligible", label });
  });

  it("routes an existing recovery attempt to reconciliation instead of a second transfer", () => {
    expect(assessPayrollRecoveryEligibility({
      ...eligible,
      claimState: "recovery_pending",
      escrowStatus: "recovery_pending"
    })).toEqual({
      state: "reconcile",
      label: "Recovery in progress — reconcile status"
    });
  });

  it("denies missing Claim PDAs and unfunded escrows", () => {
    expect(assessPayrollRecoveryEligibility({
      ...eligible,
      claimAddress: null
    }).state).toBe("ineligible");
    expect(assessPayrollRecoveryEligibility({
      ...eligible,
      escrowStatus: "preparing"
    }).state).toBe("ineligible");
  });
});

describe("claim escrow funding hold", () => {
  const hold = { claimState: "settlement_pending", escrowStatus: "funding", settlementSignature: null };

  it.each(["ready", "funding", "funded"])("recognises a settlement hold while the escrow is %s", (escrowStatus) => {
    expect(isPayrollFundingHold({ ...hold, escrowStatus })).toBe(true);
    expect(assessPayrollRecoveryEligibility({
      claimState: "settlement_pending", claimAddress: "ClaimPda111", escrowStatus
    })).toEqual({ state: "funding_hold", label: "Claim escrow funding hold — check funding" });
  });

  it("keeps a contributor claim settlement separate from a funding hold", () => {
    expect(isPayrollFundingHold({ ...hold, settlementSignature: "claim-signature" })).toBe(false);
    expect(isPayrollFundingHold({ ...hold, escrowStatus: "settlement_pending" })).toBe(false);
    expect(assessPayrollRecoveryEligibility({
      claimState: "settlement_pending", claimAddress: "ClaimPda111",
      escrowStatus: "settlement_pending", settlementSignature: "claim-signature"
    })).toMatchObject({ state: "ineligible", label: "Claim settlement in progress" });
  });

  it("is never a funding hold for an allocation that is not settlement_pending", () => {
    expect(isPayrollFundingHold({ ...hold, claimState: "unclaimed" })).toBe(false);
  });

  it("states the recorded reason, not a generic pending message", () => {
    expect(describePayrollFundingHold({ escrowStatus: "funded", stale: false })).toContain("escrow is funded");
    expect(describePayrollFundingHold({ escrowStatus: "ready", stale: false })).toContain("no funds moved");
    expect(describePayrollFundingHold({ escrowStatus: "funding", fundingSignature: "sig", stale: false }))
      .toContain("transfer was submitted");
    expect(describePayrollFundingHold({ escrowStatus: "funding", stale: true })).toContain("has stopped");
    expect(describePayrollFundingHold({ escrowStatus: "funding", stale: false })).toContain("may still be running");
  });
});

describe("recovery queue summary", () => {
  it("describes an empty queue without implying a problem", () => {
    expect(summarizePayrollRecoveryQueue([])).toBe("No allocations are unclaimed or held by escrow funding.");
  });

  it("counts each kind of row from its recorded eligibility", () => {
    expect(summarizePayrollRecoveryQueue([
      { state: "eligible", label: "" },
      { state: "funding_hold", label: "" },
      { state: "ineligible", label: "" },
      { state: "ineligible", label: "" }
    ])).toBe(
      "4 allocations: 1 eligible for recovery; 1 held by escrow funding — check funding to verify or release; 2 not eligible yet — the reason is shown on each row."
    );
  });

  it("uses the singular for one allocation", () => {
    expect(summarizePayrollRecoveryQueue([{ state: "funding_hold", label: "" }]))
      .toBe("1 allocation: 1 held by escrow funding — check funding to verify or release.");
  });
});
