import { describe, expect, it } from "vitest";
import { canAdvanceReserveFundingStage } from "./reserve-funding-operation-policy";

describe("Reserve funding operation state transitions", () => {
  it("allows only forward progress through pending, deposit and apply stages", () => {
    expect(canAdvanceReserveFundingStage("wrap_verified", "preapply_submitting")).toBe(true);
    expect(canAdvanceReserveFundingStage("wrap_verified", "preapply_finalized")).toBe(true);
    expect(canAdvanceReserveFundingStage("preapply_submitted", "preapply_finalized")).toBe(true);
    expect(canAdvanceReserveFundingStage("preapply_finalized", "deposit_submitting")).toBe(true);
    expect(canAdvanceReserveFundingStage("deposit_submitted", "deposit_finalized")).toBe(true);
    expect(canAdvanceReserveFundingStage("deposit_finalized", "apply_submitting")).toBe(true);
    expect(canAdvanceReserveFundingStage("apply_submitted", "finalized")).toBe(true);
  });

  it("allows a fresh stage attempt only after finality proves the previous attempt failed", () => {
    expect(canAdvanceReserveFundingStage("preapply_failed", "preapply_submitting")).toBe(true);
    expect(canAdvanceReserveFundingStage("deposit_failed", "deposit_submitting")).toBe(true);
    expect(canAdvanceReserveFundingStage("apply_failed", "apply_submitting")).toBe(true);
  });

  it("rejects skipped, repeated, backward and unknown transitions", () => {
    expect(canAdvanceReserveFundingStage("wrap_verified", "deposit_submitting")).toBe(false);
    expect(canAdvanceReserveFundingStage("deposit_finalized", "deposit_submitting")).toBe(false);
    expect(canAdvanceReserveFundingStage("apply_submitted", "deposit_submitting")).toBe(false);
    expect(canAdvanceReserveFundingStage("finalized", "apply_submitting")).toBe(false);
    expect(canAdvanceReserveFundingStage("unknown", "finalized")).toBe(false);
  });
});
