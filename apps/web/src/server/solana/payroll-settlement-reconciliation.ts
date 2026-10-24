import { matchesExactConfidentialDebit } from "./payroll-confidential-settlement-policy";

export type ReconciliationClaimState = "unclaimed" | "claimed" | "recovered" | "settlement_pending";
export type ReconciliationFinality = "finalized" | "failed" | "pending";

export type SettlementReconciliationResult = {
  status: "claimed" | "already_settled" | "pending" | "retry_ready" | "workspace_busy" | "state_conflict";
  signature?: string;
  amountBaseUnits?: string;
  proofDurationMs?: number;
  warning?: "proof_context_cleanup_pending";
};

export type FinalizedSettlementDependencies = {
  getFinality: () => Promise<ReconciliationFinality>;
  verifyFinalizedTransaction: () => Promise<void>;
  readFinalizedSourceAvailable: () => Promise<string>;
  readFinalizedClaimState: () => Promise<ReconciliationClaimState>;
  finalizeClaimed: () => Promise<ReconciliationFinality>;
  attachSignature: () => Promise<"attached" | "duplicate" | "conflict">;
  recordLedger: () => Promise<"claimed" | "duplicate" | "conflict">;
  cleanupProofContexts: () => Promise<boolean>;
};

/** A claim is reportable only after finalized chain evidence, exact private debit, PDA finality, and idempotent ledger recording agree. */
export async function reconcileFinalizedSettlement(input: {
  signature: string;
  amountBaseUnits: string;
  sourceAvailableBefore: string;
  proofDurationMs?: number;
}, dependencies: FinalizedSettlementDependencies): Promise<SettlementReconciliationResult> {
  const finality = await dependencies.getFinality();
  if (finality !== "finalized") {
    return { status: "pending", signature: input.signature, proofDurationMs: input.proofDurationMs };
  }

  await dependencies.verifyFinalizedTransaction();
  const sourceAvailableAfter = await dependencies.readFinalizedSourceAvailable();
  if (!matchesExactConfidentialDebit({
    amountBaseUnits: input.amountBaseUnits,
    sourceAvailableBefore: input.sourceAvailableBefore,
    sourceAvailableAfter
  })) {
    return { status: "pending", signature: input.signature, proofDurationMs: input.proofDurationMs };
  }

  let claimState = await dependencies.readFinalizedClaimState();
  if (claimState === "settlement_pending") {
    const transitionFinality = await dependencies.finalizeClaimed();
    if (transitionFinality !== "finalized") {
      return { status: "pending", signature: input.signature, proofDurationMs: input.proofDurationMs };
    }
    claimState = await dependencies.readFinalizedClaimState();
  }
  if (claimState !== "claimed") {
    return { status: "state_conflict", signature: input.signature, proofDurationMs: input.proofDurationMs };
  }

  const attached = await dependencies.attachSignature();
  if (attached !== "attached" && attached !== "duplicate") {
    return { status: "pending", signature: input.signature, proofDurationMs: input.proofDurationMs };
  }
  const recorded = await dependencies.recordLedger();
  if (recorded !== "claimed" && recorded !== "duplicate") {
    return { status: "pending", signature: input.signature, proofDurationMs: input.proofDurationMs };
  }

  const cleaned = await dependencies.cleanupProofContexts();
  return {
    status: recorded === "duplicate" ? "already_settled" : "claimed",
    signature: input.signature,
    amountBaseUnits: input.amountBaseUnits,
    proofDurationMs: input.proofDurationMs,
    ...(!cleaned ? { warning: "proof_context_cleanup_pending" as const } : {})
  };
}
