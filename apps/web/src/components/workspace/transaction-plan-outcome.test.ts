import { describe, expect, it, vi } from "vitest";
import { SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE } from "@solana/kit";
import {
  PREFLIGHT_FAILURE_ERROR_CODE,
  TRANSIENT_SUBMIT_ATTEMPTS,
  TransactionFinalityFailedError,
  TransactionFinalityPendingError,
  TransactionTrackingFailedError,
  awaitSettlement,
  awaitStepConfirmation,
  classifySettlementOutcome,
  classifyStepOutcome,
  isPreflightRejection,
  isTrackingFailure,
  isTransientSubmitError,
  readExecutionOutcome,
  submitWithTransientRetry
} from "./transaction-plan-outcome";

/** What `@solana/kit` throws: the step's error is only the `cause` of a wrapper. */
function wrappedPlanFailure(stepError: unknown, leaves?: unknown[]) {
  const wrapper = new Error("Failed to execute the transaction plan.") as Error & {
    cause?: unknown;
    context?: unknown;
  };
  wrapper.cause = stepError;
  wrapper.context = {
    __code: 7618001,
    transactionPlanResult: {
      kind: "sequential",
      plans: leaves ?? [{ kind: "single", status: "failed", error: stepError }]
    }
  };
  return wrapper;
}

describe("transaction step outcome", () => {
  it.each([
    ["no status yet", null, "pending"],
    ["processed", { confirmationStatus: "processed", err: null }, "pending"],
    ["confirmed", { confirmationStatus: "confirmed", err: null }, "confirmed"],
    ["finalized", { confirmationStatus: "finalized", err: null }, "confirmed"],
    ["failed but not final", { confirmationStatus: "confirmed", err: { InstructionError: [0, "Custom"] } }, "pending"],
    ["failed at finality", { confirmationStatus: "finalized", err: { InstructionError: [0, "Custom"] } }, "failed"]
  ] as const)("classifies %s", (_label, status, expected) => {
    expect(classifyStepOutcome(status)).toBe(expected);
  });

  it("only a finalized status settles the plan", () => {
    expect(classifySettlementOutcome({ confirmationStatus: "confirmed", err: null })).toBe("pending");
    expect(classifySettlementOutcome({ confirmationStatus: "finalized", err: null })).toBe("finalized");
    expect(classifySettlementOutcome({ confirmationStatus: "finalized", err: "boom" })).toBe("failed");
    expect(classifySettlementOutcome(null)).toBe("pending");
  });
});

describe("awaitStepConfirmation", () => {
  it("returns as soon as the step is confirmed, without waiting for finality", async () => {
    const sleep = vi.fn(async () => undefined);
    const statuses = [null, { confirmationStatus: "processed", err: null }, { confirmationStatus: "confirmed", err: null }];
    const getStatus = vi.fn(async () => statuses.shift());
    await expect(awaitStepConfirmation(getStatus, { deadline: 10_000, now: () => 0, sleep }))
      .resolves.toBe("confirmed");
    expect(getStatus).toHaveBeenCalledTimes(3);
    expect(sleep).toHaveBeenCalledTimes(2);
  });

  it("polls at least once even when the deadline has already passed", async () => {
    const getStatus = vi.fn(async () => ({ confirmationStatus: "confirmed", err: null }));
    await expect(awaitStepConfirmation(getStatus, { deadline: 0, now: () => 5 })).resolves.toBe("confirmed");
    expect(getStatus).toHaveBeenCalledOnce();
  });

  it("reports pending at the deadline and treats an RPC error as 'ask again'", async () => {
    let clock = 0;
    const getStatus = vi.fn(async () => { throw new Error("RPC unavailable"); });
    await expect(awaitStepConfirmation(getStatus, {
      deadline: 2_000,
      now: () => clock,
      sleep: async (ms) => { clock += ms; }
    })).resolves.toBe("pending");
    expect(getStatus.mock.calls.length).toBeGreaterThan(1);
  });

  it("reports a failure only when it is final", async () => {
    const getStatus = vi.fn(async () => ({ confirmationStatus: "finalized", err: { InstructionError: [0, "Custom"] } }));
    await expect(awaitStepConfirmation(getStatus, { deadline: 10_000, now: () => 0 })).resolves.toBe("failed");
  });
});

describe("awaitSettlement", () => {
  const finalized = { confirmationStatus: "finalized", err: null };
  const failed = { confirmationStatus: "finalized", err: "boom" };
  const confirmed = { confirmationStatus: "confirmed", err: null };

  it("treats an empty signature set as settled", async () => {
    await expect(awaitSettlement(async () => null, [], { deadline: 0 })).resolves.toBe("finalized");
  });

  it("is finalized only when every signature is", async () => {
    await expect(awaitSettlement(async () => finalized, ["a", "b"], { deadline: 0, now: () => 1 }))
      .resolves.toBe("finalized");
  });

  it("lets a still-pending signature outrank a failed one, so nothing is rolled back early", async () => {
    const byKey: Record<string, unknown> = { a: failed, b: confirmed };
    await expect(awaitSettlement(async (key) => byKey[key] as never, ["a", "b"], {
      deadline: 0, now: () => 1
    })).resolves.toBe("pending");
  });

  it("reports failed when the remaining signatures are final", async () => {
    const byKey: Record<string, unknown> = { a: failed, b: finalized };
    await expect(awaitSettlement(async (key) => byKey[key] as never, ["a", "b"], {
      deadline: 0, now: () => 1
    })).resolves.toBe("failed");
  });

  it("checks the signatures in parallel", async () => {
    const started: string[] = [];
    const release: Array<() => void> = [];
    const getStatus = (key: string) => new Promise<typeof finalized>((resolve) => {
      started.push(key);
      release.push(() => resolve(finalized));
    });
    const settled = awaitSettlement(getStatus, ["a", "b", "c"], { deadline: 0, now: () => 1 });
    await Promise.resolve();
    expect(started).toEqual(["a", "b", "c"]);
    release.forEach((fn) => fn());
    await expect(settled).resolves.toBe("finalized");
  });

  it("keeps polling until the signature is final or the deadline passes", async () => {
    let clock = 0;
    const statuses = [confirmed, confirmed, finalized];
    const getStatus = vi.fn(async () => statuses.shift());
    await expect(awaitSettlement(getStatus, ["a"], {
      deadline: 10_000, now: () => clock, sleep: async (ms) => { clock += ms; }
    })).resolves.toBe("finalized");
    expect(getStatus).toHaveBeenCalledTimes(3);
  });
});

describe("readExecutionOutcome", () => {
  it("sees a pending step through the executor's wrapper (an instanceof check on the thrown error never matches)", () => {
    const failure = wrappedPlanFailure(new TransactionFinalityPendingError("sig"));
    expect(failure instanceof TransactionFinalityPendingError).toBe(false);
    expect(readExecutionOutcome(failure)).toBe("pending");
  });

  it("finds a failed step that only appears in the plan-result tree", () => {
    const failure = wrappedPlanFailure(new Error("generic"), [
      { kind: "single", status: "successful" },
      { kind: "sequential", plans: [{ kind: "single", status: "failed", error: new TransactionFinalityFailedError("sig") }] }
    ]);
    expect(readExecutionOutcome(failure)).toBe("failed");
  });

  it("lets pending outrank failed", () => {
    const failure = wrappedPlanFailure(new TransactionFinalityFailedError("a"), [
      { kind: "single", status: "failed", error: new TransactionFinalityFailedError("a") },
      { kind: "single", status: "failed", error: new TransactionFinalityPendingError("b") }
    ]);
    expect(readExecutionOutcome(failure)).toBe("pending");
  });

  it("returns null for any other failure so the caller rethrows it", () => {
    expect(readExecutionOutcome(wrappedPlanFailure(new Error("simulation failed")))).toBeNull();
    expect(readExecutionOutcome("not an error")).toBeNull();
    expect(readExecutionOutcome(undefined)).toBeNull();
  });

  it("survives a cyclic cause chain", () => {
    const first = new Error("a") as Error & { cause?: unknown };
    const second = new Error("b") as Error & { cause?: unknown };
    first.cause = second;
    second.cause = first;
    expect(readExecutionOutcome(first)).toBeNull();
  });

  it("recognises a signature that could not be recorded", () => {
    expect(isTrackingFailure(wrappedPlanFailure(new TransactionTrackingFailedError("sig")))).toBe(true);
    expect(isTrackingFailure(wrappedPlanFailure(new Error("other")))).toBe(false);
  });
});

describe("preflight rejection", () => {
  it("matches kit's own error code, so a kit upgrade cannot silently break the check", () => {
    expect(PREFLIGHT_FAILURE_ERROR_CODE).toBe(
      SOLANA_ERROR__JSON_RPC__SERVER_ERROR_SEND_TRANSACTION_PREFLIGHT_FAILURE
    );
  });

  it("is found on the wrapped step error", () => {
    const rejected = Object.assign(new Error("Transaction simulation failed"), {
      context: { __code: PREFLIGHT_FAILURE_ERROR_CODE }
    });
    expect(isPreflightRejection(wrappedPlanFailure(rejected))).toBe(true);
    expect(isPreflightRejection(wrappedPlanFailure(new Error("network down")))).toBe(false);
  });
});

describe("submitWithTransientRetry", () => {
  const notYetVisible = Object.assign(new Error("Transaction simulation failed"), {
    context: { __code: PREFLIGHT_FAILURE_ERROR_CODE, logs: ["Program log: AccountNotFound"] }
  });

  it("recognises only the lag-related simulation misses as transient", () => {
    expect(isTransientSubmitError(notYetVisible)).toBe(true);
    expect(isTransientSubmitError(new Error("Blockhash not found"))).toBe(true);
    expect(isTransientSubmitError(new Error("custom program error: 0x1"))).toBe(false);
  });

  it("retries a miss caused by a node a moment behind, then succeeds", async () => {
    const send = vi.fn()
      .mockRejectedValueOnce(notYetVisible)
      .mockResolvedValueOnce("signature");
    const sleep = vi.fn(async () => undefined);
    await expect(submitWithTransientRetry(send, { sleep })).resolves.toBe("signature");
    expect(send).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledOnce();
  });

  it("gives up after a bounded number of attempts", async () => {
    const send = vi.fn().mockRejectedValue(notYetVisible);
    await expect(submitWithTransientRetry(send, { sleep: async () => undefined })).rejects.toBe(notYetVisible);
    expect(send).toHaveBeenCalledTimes(TRANSIENT_SUBMIT_ATTEMPTS);
  });

  it("never retries a real failure", async () => {
    const real = new Error("custom program error: 0x1");
    const send = vi.fn().mockRejectedValue(real);
    await expect(submitWithTransientRetry(send, { sleep: async () => undefined })).rejects.toBe(real);
    expect(send).toHaveBeenCalledOnce();
  });
});
