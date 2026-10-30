export const RESERVE_FUNDING_OPERATION_TYPE = "reserve_ordinary_usdc_confidential_funding";

export type ReserveFundingOperationStage =
  | "wrap_verified"
  | "preapply_submitting"
  | "preapply_submitted"
  | "preapply_finalized"
  | "preapply_failed"
  | "deposit_submitting"
  | "deposit_submitted"
  | "deposit_finalized"
  | "deposit_failed"
  | "apply_submitting"
  | "apply_submitted"
  | "apply_failed"
  | "finalized";

const transitions: Record<ReserveFundingOperationStage, readonly ReserveFundingOperationStage[]> = {
  wrap_verified: ["preapply_submitting", "preapply_finalized"],
  preapply_submitting: ["preapply_submitted"],
  preapply_submitted: ["preapply_finalized", "preapply_failed"],
  preapply_finalized: ["deposit_submitting"],
  preapply_failed: ["preapply_submitting"],
  deposit_submitting: ["deposit_submitted"],
  deposit_submitted: ["deposit_finalized", "deposit_failed"],
  deposit_finalized: ["apply_submitting"],
  deposit_failed: ["deposit_submitting"],
  apply_submitting: ["apply_submitted"],
  apply_submitted: ["apply_failed", "finalized"],
  apply_failed: ["apply_submitting"],
  finalized: []
};

export function canAdvanceReserveFundingStage(
  current: string,
  next: ReserveFundingOperationStage
): boolean {
  return Object.prototype.hasOwnProperty.call(transitions, current) &&
    transitions[current as ReserveFundingOperationStage].includes(next);
}
