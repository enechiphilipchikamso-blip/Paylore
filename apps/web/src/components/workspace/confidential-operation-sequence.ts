export type ConfidentialSettlementStep =
  | "reserve_configure"
  | "pending_apply_before_deposit"
  | "deposit"
  | "pending_apply_after_deposit"
  | "proof_setup"
  | "confidential_transfer";

export type ConfidentialSequenceProgress = {
  completed: ConfidentialSettlementStep[];
};

export type ConfidentialStepFinality = "finalized" | "pending" | "failed";

export function createConfidentialSequenceProgress(): ConfidentialSequenceProgress {
  return { completed: [] };
}

function allowedNextSteps(progress: ConfidentialSequenceProgress): ConfidentialSettlementStep[] {
  const last = progress.completed.at(-1);
  if (!last) return ["reserve_configure"];
  switch (last) {
    case "reserve_configure":
      return ["pending_apply_before_deposit", "deposit", "proof_setup"];
    case "pending_apply_before_deposit":
      return ["deposit", "proof_setup"];
    case "deposit":
      return ["pending_apply_after_deposit"];
    case "pending_apply_after_deposit":
      return ["proof_setup"];
    case "proof_setup":
      return ["confidential_transfer"];
    case "confidential_transfer":
      return [];
  }
}

/** Prevents a settlement from crossing a proof or value-transfer boundary out of protocol order. */
export function assertConfidentialStepAllowed(
  progress: ConfidentialSequenceProgress,
  step: ConfidentialSettlementStep
): void {
  if (!allowedNextSteps(progress).includes(step)) {
    throw new Error(`Confidential settlement step ${step} is not allowed after ${progress.completed.at(-1) ?? "start"}.`);
  }
}

export function advanceConfidentialSequence(
  progress: ConfidentialSequenceProgress,
  step: ConfidentialSettlementStep,
  finality: ConfidentialStepFinality
): ConfidentialSequenceProgress {
  assertConfidentialStepAllowed(progress, step);
  if (finality !== "finalized") {
    throw new Error(`Confidential settlement step ${step} is ${finality}; later steps are not safe to run.`);
  }
  return { completed: [...progress.completed, step] };
}

/** Approval is mint-authority controlled; this client must not pretend owner signing can approve it. */
export function assertConfidentialAccountAutoApproval(input: {
  confidentialTransferExtensionPresent: boolean;
  autoApproveNewAccounts: boolean;
}): void {
  if (!input.confidentialTransferExtensionPresent) {
    throw new Error("The configured mint does not support confidential transfers. No account setup transaction was submitted.");
  }
  if (!input.autoApproveNewAccounts) {
    throw new Error("This mint requires approval by its confidential-transfer mint authority. Company-sponsored account setup cannot approve it; no transaction was submitted.");
  }
}

/** Requires exact private debit and public-token credit before calling a confidential withdrawal complete. */
export function assertExactConfidentialWithdrawal(input: {
  amountBaseUnits: bigint;
  availableBefore: bigint;
  availableAfter: bigint;
  publicBefore: bigint;
  publicAfter: bigint;
  transactionSignature: string;
}): void {
  const debit = input.availableBefore - input.availableAfter;
  const credit = input.publicAfter - input.publicBefore;
  if (
    input.amountBaseUnits <= 0n ||
    input.availableBefore < input.availableAfter ||
    input.publicAfter < input.publicBefore ||
    debit !== input.amountBaseUnits ||
    credit !== input.amountBaseUnits
  ) {
    throw new Error(
      `The confidential withdrawal finalized, but the exact confidential debit and public-token credit could not be reconciled. Do not submit a duplicate withdrawal. Transaction: ${input.transactionSignature}`
    );
  }
}
