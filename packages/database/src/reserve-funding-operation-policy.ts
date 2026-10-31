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

function fundingAttempt(value: unknown, retry: boolean): number {
  const current = value === undefined
    ? 0
    : typeof value === "number" && Number.isSafeInteger(value) && value >= 0
      ? value
      : null;
  if (current === null) throw new Error("Invalid persisted Reserve funding attempt counter.");
  const attempt = retry ? current + 1 : Math.max(current, 1);
  if (attempt < 1 || attempt > 1000) {
    throw new Error("Reserve confidential funding retry limit reached.");
  }
  return attempt;
}

/** Returns the confidential phases that need a fee reservation before this operation resumes. */
export function getReserveFundingFeeReservationKeys(input: {
  stage: string;
  pendingBalance: bigint;
  preapplyAttempt?: unknown;
  depositAttempt?: unknown;
  applyAttempt?: unknown;
}): string[] {
  const keys: string[] = [];
  const addCurrent = (phase: "preapply" | "deposit" | "apply", attempt: unknown) => {
    if (attempt === undefined) throw new Error("Missing active Reserve funding attempt counter.");
    keys.push(phase + ":" + fundingAttempt(attempt, false));
  };
  const addNext = (phase: "preapply" | "deposit" | "apply", attempt: unknown) =>
    keys.push(phase + ":" + fundingAttempt(attempt, true));

  switch (input.stage) {
    case "wrap_verified":
      if (input.pendingBalance > 0n) addNext("preapply", input.preapplyAttempt);
      addNext("deposit", input.depositAttempt);
      addNext("apply", input.applyAttempt);
      break;
    case "preapply_submitting":
      addCurrent("preapply", input.preapplyAttempt);
      addNext("deposit", input.depositAttempt);
      addNext("apply", input.applyAttempt);
      break;
    case "preapply_submitted":
      addNext("deposit", input.depositAttempt);
      addNext("apply", input.applyAttempt);
      break;
    case "preapply_failed":
      addNext("preapply", input.preapplyAttempt);
      addNext("deposit", input.depositAttempt);
      addNext("apply", input.applyAttempt);
      break;
    case "preapply_finalized":
      addNext("deposit", input.depositAttempt);
      addNext("apply", input.applyAttempt);
      break;
    case "deposit_submitting":
      addCurrent("deposit", input.depositAttempt);
      addNext("apply", input.applyAttempt);
      break;
    case "deposit_submitted":
      addNext("apply", input.applyAttempt);
      break;
    case "deposit_failed":
      addNext("deposit", input.depositAttempt);
      addNext("apply", input.applyAttempt);
      break;
    case "deposit_finalized":
      addNext("apply", input.applyAttempt);
      break;
    case "apply_submitting":
      addCurrent("apply", input.applyAttempt);
      break;
    case "apply_failed":
      addNext("apply", input.applyAttempt);
      break;
    case "apply_submitted":
    case "finalized":
    case "wrap_pending":
    case "wrap_failed":
      break;
    default:
      throw new Error("Unknown Reserve confidential funding stage.");
  }
  return keys;
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
