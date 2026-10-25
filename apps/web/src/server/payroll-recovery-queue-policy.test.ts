import { describe, expect, it } from "vitest";
import { assessPayrollRecoveryEligibility } from "./payroll-recovery-queue-policy";

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
