import { describe, expect, it } from "vitest";
import {
  canAdvanceReserveFundingStage,
  isExactReserveFundingApply,
  isExactReserveFundingDeposit,
  isExactReserveFundingPreapply,
  isUnchangedReserveFundingBalance
} from "./reserve-funding-operation-policy";

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


describe("Reserve confidential balance transitions", () => {
  const initial = {
    publicBalance: 5_000_000n,
    pendingBalance: 0n,
    availableBalance: 2_000_000n
  };

  it("checks the full pending-to-available pre-apply transition", () => {
    expect(isExactReserveFundingPreapply(
      { ...initial, pendingBalance: 1_000_000n },
      { ...initial, availableBalance: 3_000_000n }
    )).toBe(true);
    expect(isExactReserveFundingPreapply(
      { ...initial, pendingBalance: 1_000_000n },
      { ...initial, availableBalance: 2_000_000n }
    )).toBe(false);
  });

  it("checks public debit, pending credit and unchanged available balance on deposit", () => {
    expect(isExactReserveFundingDeposit(
      initial,
      { publicBalance: 4_000_000n, pendingBalance: 1_000_000n, availableBalance: 2_000_000n },
      1_000_000n
    )).toBe(true);
    expect(isExactReserveFundingDeposit(
      initial,
      { publicBalance: 4_000_000n, pendingBalance: 999_999n, availableBalance: 2_000_000n },
      1_000_000n
    )).toBe(false);
    expect(isExactReserveFundingDeposit(initial, initial, (1n << 48n))).toBe(false);
  });

  it("checks pending-to-available application without another public balance change", () => {
    expect(isExactReserveFundingApply(
      { publicBalance: 4_000_000n, pendingBalance: 1_000_000n, availableBalance: 2_000_000n },
      { publicBalance: 4_000_000n, pendingBalance: 0n, availableBalance: 3_000_000n },
      1_000_000n
    )).toBe(true);
    expect(isExactReserveFundingApply(
      { publicBalance: 4_000_000n, pendingBalance: 1_000_000n, availableBalance: 2_000_000n },
      { publicBalance: 4_000_000n, pendingBalance: 0n, availableBalance: 2_999_999n },
      1_000_000n
    )).toBe(false);
  });

  it("distinguishes an unchanged balance after a finalized failed transaction", () => {
    expect(isUnchangedReserveFundingBalance(initial, { ...initial })).toBe(true);
    expect(isUnchangedReserveFundingBalance(initial, { ...initial, publicBalance: 4_999_999n })).toBe(false);
  });
});
