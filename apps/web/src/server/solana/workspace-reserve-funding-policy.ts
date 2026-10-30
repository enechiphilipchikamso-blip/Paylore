export type WorkspaceReserveFundingStage =
  | "wrap_verified"
  | "deposit_building"
  | "deposit_pending"
  | "deposit_finalized"
  | "apply_building"
  | "apply_pending"
  | "completed"
  | "failed";

export const MAX_CONFIDENTIAL_DEPOSIT_BASE_UNITS = (1n << 48n) - 1n;

const transitions: Record<WorkspaceReserveFundingStage, readonly WorkspaceReserveFundingStage[]> = {
  wrap_verified: ["deposit_building", "failed"],
  deposit_building: ["deposit_pending", "wrap_verified", "failed"],
  deposit_pending: ["deposit_finalized", "wrap_verified", "failed"],
  deposit_finalized: ["apply_building"],
  apply_building: ["apply_pending", "deposit_finalized"],
  apply_pending: ["completed", "deposit_finalized", "failed"],
  completed: [],
  failed: []
};

export function canTransitionReserveFundingStage(
  current: WorkspaceReserveFundingStage,
  next: WorkspaceReserveFundingStage
): boolean {
  return transitions[current].includes(next);
}

export function assertConfidentialDepositAmount(amount: bigint): void {
  if (amount <= 0n || amount > MAX_CONFIDENTIAL_DEPOSIT_BASE_UNITS) {
    throw new Error("reserve_confidential_deposit_amount_invalid");
  }
}

export function assertExactReserveConfidentialDeposit(input: {
  amountBaseUnits: bigint;
  publicBalanceBefore: bigint;
  publicBalanceAfter: bigint;
  pendingBalanceBefore: bigint;
  pendingBalanceAfter: bigint;
  availableBalanceBefore: bigint;
  availableBalanceAfter: bigint;
}): void {
  assertConfidentialDepositAmount(input.amountBaseUnits);
  if (
    input.pendingBalanceBefore !== 0n ||
    input.publicBalanceBefore - input.publicBalanceAfter !== input.amountBaseUnits ||
    input.pendingBalanceAfter - input.pendingBalanceBefore !== input.amountBaseUnits ||
    input.availableBalanceAfter !== input.availableBalanceBefore
  ) {
    throw new Error("reserve_confidential_deposit_balance_mismatch");
  }
}

export function assertExactReserveConfidentialApply(input: {
  amountBaseUnits: bigint;
  publicBalanceBefore: bigint;
  publicBalanceAfter: bigint;
  pendingBalanceBefore: bigint;
  pendingBalanceAfter: bigint;
  availableBalanceBefore: bigint;
  availableBalanceAfter: bigint;
}): void {
  assertConfidentialDepositAmount(input.amountBaseUnits);
  if (
    input.pendingBalanceBefore !== input.amountBaseUnits ||
    input.pendingBalanceAfter !== 0n ||
    input.publicBalanceAfter !== input.publicBalanceBefore ||
    input.availableBalanceAfter - input.availableBalanceBefore !== input.amountBaseUnits
  ) {
    throw new Error("reserve_confidential_apply_balance_mismatch");
  }
}
