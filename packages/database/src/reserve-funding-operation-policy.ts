export const RESERVE_FUNDING_OPERATION_TYPE = "reserve_ordinary_usdc_confidential_funding";

export type ReserveFundingOperationStage =
  | "wrap_pending"
  | "wrap_verified"
  | "wrap_failed"
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
  wrap_pending: ["wrap_verified", "wrap_failed"],
  wrap_verified: ["preapply_submitting", "preapply_finalized"],
  wrap_failed: [],
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


export type ReserveFundingBalances = {
  publicBalance: bigint;
  pendingBalance: bigint;
  availableBalance: bigint;
};

export function isExactReserveFundingPreapply(
  before: ReserveFundingBalances,
  after: ReserveFundingBalances
): boolean {
  return before.pendingBalance > 0n &&
    after.publicBalance === before.publicBalance &&
    after.pendingBalance === 0n &&
    after.availableBalance === before.availableBalance + before.pendingBalance;
}

export function isExactReserveFundingDeposit(
  before: ReserveFundingBalances,
  after: ReserveFundingBalances,
  amount: bigint
): boolean {
  return amount > 0n &&
    amount <= (1n << 48n) - 1n &&
    before.pendingBalance === 0n &&
    before.publicBalance - after.publicBalance === amount &&
    after.pendingBalance - before.pendingBalance === amount &&
    after.availableBalance === before.availableBalance;
}

export function isExactReserveFundingApply(
  before: ReserveFundingBalances,
  after: ReserveFundingBalances,
  amount: bigint
): boolean {
  return amount > 0n &&
    amount <= (1n << 48n) - 1n &&
    before.pendingBalance === amount &&
    after.publicBalance === before.publicBalance &&
    after.pendingBalance === 0n &&
    after.availableBalance - before.availableBalance === amount;
}

export function isUnchangedReserveFundingBalance(
  expected: ReserveFundingBalances,
  current: ReserveFundingBalances
): boolean {
  return current.publicBalance === expected.publicBalance &&
    current.pendingBalance === expected.pendingBalance &&
    current.availableBalance === expected.availableBalance;
}
