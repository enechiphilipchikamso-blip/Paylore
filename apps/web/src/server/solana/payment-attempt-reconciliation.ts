export const PAYMENT_ATTEMPT_SIGNATURE_SCAN_LIMIT = 1000;

export type RecentPayerSignature = {
  signature: string;
  slot: number;
  err: unknown;
  memo: string | null;
  blockTime: number | null;
};

export type AmbiguousAttemptDecision =
  | { kind: "still_pending" }
  | { kind: "submitted"; signature: string; failedOnChain: boolean }
  | { kind: "safe_to_retry" };

/**
 * Retry is permitted only after blockhash expiry and complete finalized-history
 * coverage of the interval since this unique payment attempt was created.
 */
export function assessAmbiguousPaymentAttempt(input: {
  currentFinalizedBlockHeight: number;
  lastValidBlockHeight: number;
  attemptCreatedAt: Date;
  expectedMemo: string;
  signatures: readonly RecentPayerSignature[];
  limit?: number;
}): AmbiguousAttemptDecision {
  const matching = input.signatures.find((entry) => entry.memo === input.expectedMemo);
  if (matching) {
    return { kind: "submitted", signature: matching.signature, failedOnChain: matching.err !== null };
  }
  if (input.currentFinalizedBlockHeight <= input.lastValidBlockHeight) {
    return { kind: "still_pending" };
  }
  const limit = input.limit ?? PAYMENT_ATTEMPT_SIGNATURE_SCAN_LIMIT;
  if (input.signatures.length >= limit) {
    const oldest = input.signatures[input.signatures.length - 1];
    if (!oldest || oldest.blockTime === null || oldest.blockTime * 1000 > input.attemptCreatedAt.getTime()) {
      return { kind: "still_pending" };
    }
  }
  return { kind: "safe_to_retry" };
}
