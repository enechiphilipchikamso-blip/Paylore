/**
 * Outcome handling shared by every transaction-plan runner, on the server and in
 * the browser. It is pure (no RPC client, no Solana imports) so it can be tested
 * without mocking the network.
 *
 * Two facts about `@solana/kit` shape it:
 *
 * 1. A plan executor never rethrows what a step threw. It wraps it in a
 *    `FAILED_TO_EXECUTE_TRANSACTION_PLAN` error and keeps the original as `cause`
 *    (and in the non-enumerable `context.transactionPlanResult` tree). A runner
 *    that tests `error instanceof FinalityPendingError` on the thrown value never
 *    matches, so `readExecutionOutcome` looks through the wrapper.
 * 2. Dependent steps (create the proof account, then verify the proof into it)
 *    only need the previous step to be *confirmed*. Waiting for finality between
 *    them doubles the latency of every proof setup, so steps wait for
 *    confirmation and the whole plan settles to finality once, together.
 */

/** The part of a `getSignatureStatuses` entry the runners read. */
export type SignatureStatus = {
  err?: unknown;
  confirmationStatus?: string | null;
} | null | undefined;

/** What a submitted transaction's status allows the runner to do next. */
export type StepOutcome = "confirmed" | "failed" | "pending";
export type SettlementOutcome = "finalized" | "failed" | "pending";

/**
 * `confirmed` lets a dependent step proceed. `failed` is reported only once it is
 * final: a failure seen before finality can still disappear on a fork, so it
 * keeps waiting rather than rolling back a transaction that may yet succeed.
 */
export function classifyStepOutcome(status: SignatureStatus): StepOutcome {
  if (!status) return "pending";
  const finalized = status.confirmationStatus === "finalized";
  if (status.err !== null && status.err !== undefined) return finalized ? "failed" : "pending";
  return finalized || status.confirmationStatus === "confirmed" ? "confirmed" : "pending";
}

/** Only a finalized status is authoritative for the whole plan. */
export function classifySettlementOutcome(status: SignatureStatus): SettlementOutcome {
  if (!status || status.confirmationStatus !== "finalized") return "pending";
  return status.err === null || status.err === undefined ? "finalized" : "failed";
}

export class TransactionFinalityPendingError extends Error {
  constructor(readonly signature: string) {
    super("The transaction is awaiting confirmation.");
    this.name = "TransactionFinalityPendingError";
  }
}

export class TransactionFinalityFailedError extends Error {
  constructor(readonly signature: string) {
    super("The transaction failed at finality.");
    this.name = "TransactionFinalityFailedError";
  }
}

/**
 * Thrown to stop a sequence when a submitted signature could not be recorded.
 * The next step must not be sent while the previous one is untracked.
 */
export class TransactionTrackingFailedError extends Error {
  constructor(readonly signature: string) {
    super("The transaction signature could not be recorded.");
    this.name = "TransactionTrackingFailedError";
  }
}

type Poll = {
  /** Absolute time (ms since epoch) after which the answer is "pending". */
  deadline: number;
  intervalMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_INTERVAL_MS = 1_000;
const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Polls one signature until it is confirmed, fails at finality, or the deadline
 * passes. A provider error is not a transaction failure, so it only means "ask again".
 */
export async function awaitStepConfirmation(
  getStatus: () => Promise<SignatureStatus>,
  poll: Poll
): Promise<StepOutcome> {
  const now = poll.now ?? Date.now;
  const sleep = poll.sleep ?? defaultSleep;
  for (;;) {
    try {
      const outcome = classifyStepOutcome(await getStatus());
      if (outcome !== "pending") return outcome;
    } catch {
      // Ask again until the deadline.
    }
    if (now() >= poll.deadline) return "pending";
    await sleep(poll.intervalMs ?? DEFAULT_INTERVAL_MS);
  }
}

/**
 * Waits until every submitted signature is final. `pending` wins over `failed`:
 * while any transaction may still land, a rollback is not safe.
 */
export async function awaitSettlement(
  getStatus: (signature: string) => Promise<SignatureStatus>,
  signatures: readonly string[],
  poll: Poll
): Promise<SettlementOutcome> {
  if (signatures.length === 0) return "finalized";
  const now = poll.now ?? Date.now;
  const sleep = poll.sleep ?? defaultSleep;
  for (;;) {
    const outcomes = await Promise.all(signatures.map(async (signature) => {
      try {
        return classifySettlementOutcome(await getStatus(signature));
      } catch {
        return "pending" as const;
      }
    }));
    if (!outcomes.includes("pending")) {
      return outcomes.includes("failed") ? "failed" : "finalized";
    }
    if (now() >= poll.deadline) return "pending";
    await sleep(poll.intervalMs ?? DEFAULT_INTERVAL_MS);
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : null;
}

/** Every error that explains a failed plan: the thrown one, its causes, and each failed step. */
function explainingErrors(error: unknown): unknown[] {
  const found: unknown[] = [];
  const seen = new Set<unknown>();
  const visit = (value: unknown, depth: number): void => {
    if (value === undefined || value === null || seen.has(value) || depth > 8) return;
    seen.add(value);
    found.push(value);
    const record = asRecord(value);
    if (!record) return;
    visit(record.cause, depth + 1);
    // `transactionPlanResult` is a tree of results; its failed leaves hold the real errors.
    const tree = asRecord(asRecord(record.context)?.transactionPlanResult);
    const walk = (node: unknown, level: number): void => {
      const item = asRecord(node);
      if (!item || level > 8) return;
      if (item.kind === "single") {
        if (item.status === "failed") visit(item.error, depth + 1);
        return;
      }
      if (Array.isArray(item.plans)) item.plans.forEach((child) => walk(child, level + 1));
    };
    walk(tree, 0);
  };
  visit(error, 0);
  return found;
}

/**
 * Says whether a failed plan failed because a transaction is still awaiting
 * confirmation (`pending`), failed at finality (`failed`), or for any other
 * reason (`null`, so the caller rethrows it). `pending` wins: a plan with one
 * unresolved transaction is unresolved.
 */
export function readExecutionOutcome(error: unknown): "pending" | "failed" | null {
  const errors = explainingErrors(error);
  if (errors.some((item) => item instanceof TransactionFinalityPendingError)) return "pending";
  if (errors.some((item) => item instanceof TransactionFinalityFailedError)) return "failed";
  return null;
}

/** True when the plan stopped because a signature could not be recorded. */
export function isTrackingFailure(error: unknown): boolean {
  return explainingErrors(error).some((item) => item instanceof TransactionTrackingFailedError);
}

/** The code `@solana/errors` gives a send that the node's preflight simulation rejected. */
export const PREFLIGHT_FAILURE_ERROR_CODE = -32002;

/**
 * True when the node rejected the transaction in preflight. Nothing was
 * submitted, so no signature exists and the step can be rolled back safely.
 */
export function isPreflightRejection(error: unknown): boolean {
  return explainingErrors(error).some(
    (item) => asRecord(asRecord(item)?.context)?.__code === PREFLIGHT_FAILURE_ERROR_CODE
  );
}

function errorText(error: unknown): string {
  return explainingErrors(error).map((item) => {
    const record = asRecord(item);
    const logs = asRecord(record?.context)?.logs;
    return [
      item instanceof Error ? item.message : typeof item === "string" ? item : "",
      Array.isArray(logs) ? logs.join(" ") : ""
    ].join(" ");
  }).join(" ");
}

/**
 * A dependent step is simulated against the node's view of the previous step's
 * result. A node a moment behind reports the missing account or blockhash;
 * the same transaction succeeds a moment later, so only these are retried.
 */
export function isTransientSubmitError(error: unknown): boolean {
  return /(account ?not ?found|could not find account|invalid account data|blockhash not found|blockhashnotfound)/i
    .test(errorText(error));
}

export const TRANSIENT_SUBMIT_ATTEMPTS = 3;
export const TRANSIENT_SUBMIT_DELAY_MS = 500;

/** Sends once, retrying only the transient preflight misses described above. */
export async function submitWithTransientRetry<T>(
  send: () => Promise<T>,
  options: { sleep?: (ms: number) => Promise<void> } = {}
): Promise<T> {
  const sleep = options.sleep ?? defaultSleep;
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await send();
    } catch (error) {
      if (attempt >= TRANSIENT_SUBMIT_ATTEMPTS || !isTransientSubmitError(error)) throw error;
      await sleep(TRANSIENT_SUBMIT_DELAY_MS);
    }
  }
}
