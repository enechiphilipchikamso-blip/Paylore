import { describe, expect, it } from "vitest";
import { assessAmbiguousPaymentAttempt, PAYMENT_ATTEMPT_SIGNATURE_SCAN_LIMIT, type RecentPayerSignature } from "./payment-attempt-reconciliation";

const createdAt = new Date("2026-10-21T12:00:00.000Z");
const memo = "Paylore activation attempt 55a0 | workspace ws-a";
function entry(overrides: Partial<RecentPayerSignature> = {}): RecentPayerSignature {
  return { signature: "1".repeat(64), slot: 10, err: null, memo: null, blockTime: Math.floor(createdAt.getTime() / 1000) + 5, ...overrides };
}
describe("ambiguous subscription payment reconciliation", () => {
  it("recovers a landed signature from the unique transaction memo", () => {
    expect(assessAmbiguousPaymentAttempt({ currentFinalizedBlockHeight: 500, lastValidBlockHeight: 600, attemptCreatedAt: createdAt, expectedMemo: memo, signatures: [entry({ memo })] })).toEqual({ kind: "submitted", signature: "1".repeat(64), failedOnChain: false });
  });
  it("does not permit retry before the original blockhash expires", () => {
    expect(assessAmbiguousPaymentAttempt({ currentFinalizedBlockHeight: 600, lastValidBlockHeight: 600, attemptCreatedAt: createdAt, expectedMemo: memo, signatures: [] })).toEqual({ kind: "still_pending" });
  });
  it("permits retry after expiry when history covers the attempt interval without a matching memo", () => {
    expect(assessAmbiguousPaymentAttempt({ currentFinalizedBlockHeight: 601, lastValidBlockHeight: 600, attemptCreatedAt: createdAt, expectedMemo: memo, signatures: [entry({ blockTime: Math.floor(createdAt.getTime() / 1000) - 1 })] })).toEqual({ kind: "safe_to_retry" });
  });
  it("keeps retry blocked when a full history page does not reach attempt creation", () => {
    const signatures = Array.from({ length: PAYMENT_ATTEMPT_SIGNATURE_SCAN_LIMIT }, (_, i) => entry({ signature: String(i + 1).repeat(64).slice(0, 64), blockTime: Math.floor(createdAt.getTime() / 1000) + 1 }));
    expect(assessAmbiguousPaymentAttempt({ currentFinalizedBlockHeight: 900, lastValidBlockHeight: 600, attemptCreatedAt: createdAt, expectedMemo: memo, signatures })).toEqual({ kind: "still_pending" });
  });
  it("detects a memo-matched failed transaction", () => {
    expect(assessAmbiguousPaymentAttempt({ currentFinalizedBlockHeight: 900, lastValidBlockHeight: 600, attemptCreatedAt: createdAt, expectedMemo: memo, signatures: [entry({ memo, err: { InstructionError: [1, "Custom"] } })] })).toEqual({ kind: "submitted", signature: "1".repeat(64), failedOnChain: true });
  });
});
