import { describe, expect, it } from "vitest";
import { getClaimAndCashOutOutcome } from "./claim-and-cash-out-outcome";

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

  it("keeps finality and proof-context cleanup pending separate from success", () => {
    expect(getClaimAndCashOutOutcome({
      settled: 1, pending: 2, failed: 0, cleanupPending: 1, stateConflict: false
    })).toEqual({
      state: "partial",
      text: "1 allocation(s) settled; 2 await finality or retry, and 1 need proof-context cleanup."
    });
  });
});
