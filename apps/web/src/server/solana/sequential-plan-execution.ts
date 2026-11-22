import "server-only";

import {
  createTransactionPlanExecutor,
  type createSolanaRpc,
  type Signature,
  type TransactionMessage,
  type TransactionMessageWithFeePayer,
  type TransactionPlan
} from "@solana/kit";
import {
  awaitSettlement,
  awaitStepConfirmation,
  readExecutionOutcome,
  submitWithTransientRetry,
  TransactionFinalityFailedError,
  TransactionFinalityPendingError,
  TransactionTrackingFailedError
} from "../../components/workspace/transaction-plan-outcome";

export type SequentialPlanResult = {
  /** Every transaction finalized and every signature was recorded. */
  successful: boolean;
  /** A submitted transaction has not reached a final answer yet. */
  pending: boolean;
  signatures: string[];
  trackingFailed: boolean;
};

export type PreparedTransaction = {
  /** The signed transaction, base64 wire encoded. */
  wire: string;
  /** The signature the wire transaction must produce, when the caller recorded it beforehand. */
  expectedSignature?: string;
};

/**
 * Runs a planned transaction tree in the order the plan states, then waits for
 * every submitted transaction to be final.
 *
 * This is the only place a server transaction plan is executed. It uses the
 * sequential `createTransactionPlanExecutor`: the library's
 * `createTransactionPlanExecutorWithConcurrentLeaves` starts every step at once,
 * which sent the "verify proof" transaction before the "create proof account"
 * transaction that it depends on, left an all-zero proof account behind, and
 * stranded every confidential transfer that followed. Independent branches of a
 * parallel plan still run together; steps of a sequential plan run one after
 * another, each after the previous one is confirmed.
 *
 * It returns, and throws, as follows:
 * - Every submitted transaction is settled (final, failed, or still pending)
 *   before it returns or throws, so a caller never rolls back while one may land.
 * - A transaction that is still pending, or that failed at finality, is a result
 *   (`pending`, or `successful: false`), never an exception.
 * - A rejection before any submission (a failed preflight, a bad plan) is
 *   rethrown unchanged for the caller to classify.
 */
export async function executeTransactionPlanSequentially(input: {
  rpc: ReturnType<typeof createSolanaRpc>;
  plan: TransactionPlan;
  /** Signs one planned message. Runs immediately before that message is sent. */
  prepare: (message: TransactionMessage & TransactionMessageWithFeePayer) => Promise<PreparedTransaction>;
  /** Records a signature durably as soon as it exists. A throw stops the sequence. */
  onSubmitted?: (signature: string) => Promise<void>;
  /** One budget for the whole plan, shared by every wait in it. */
  timeoutMs: number;
  signatureMismatchError?: () => Error;
}): Promise<SequentialPlanResult> {
  const deadline = Date.now() + input.timeoutMs;
  const signatures: string[] = [];
  let trackingFailed = false;
  const statusOf = async (signature: string) =>
    (await input.rpc.getSignatureStatuses([signature as Signature], { searchTransactionHistory: true }).send()).value[0];

  const executor = createTransactionPlanExecutor({
    executeTransactionMessage: async (_context, message) => {
      const prepared = await input.prepare(message);
      const signature = await submitWithTransientRetry(() => input.rpc.sendTransaction(prepared.wire as never, {
        encoding: "base64", preflightCommitment: "confirmed", maxRetries: 3n
      }).send());
      const text = String(signature);
      if (prepared.expectedSignature !== undefined && text !== prepared.expectedSignature) {
        throw input.signatureMismatchError?.() ?? new Error("The submitted transaction signature did not match the prepared one.");
      }
      signatures.push(text);
      if (input.onSubmitted) {
        try {
          await input.onSubmitted(text);
        } catch {
          trackingFailed = true;
          throw new TransactionTrackingFailedError(text);
        }
      }
      // A dependent step needs this one confirmed, not final; finality is awaited
      // once for the whole plan below.
      const outcome = await awaitStepConfirmation(() => statusOf(text), { deadline });
      if (outcome === "pending") throw new TransactionFinalityPendingError(text);
      if (outcome === "failed") throw new TransactionFinalityFailedError(text);
      return { signature };
    }
  });

  let failure: unknown;
  let failed = false;
  try {
    await executor(input.plan);
  } catch (error) {
    failure = error;
    failed = true;
  }

  const settled = await awaitSettlement(statusOf, signatures, { deadline });
  if (settled === "pending" || (failed && readExecutionOutcome(failure) === "pending")) {
    return { successful: false, pending: true, signatures, trackingFailed };
  }
  if (settled === "failed" || trackingFailed || (failed && readExecutionOutcome(failure) === "failed")) {
    return { successful: false, pending: false, signatures, trackingFailed };
  }
  if (failed) throw failure;
  return { successful: true, pending: false, signatures, trackingFailed };
}
