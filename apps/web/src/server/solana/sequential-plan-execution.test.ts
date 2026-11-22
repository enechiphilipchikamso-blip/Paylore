import { describe, expect, it, vi } from "vitest";
import {
  createTransactionPlanExecutorWithConcurrentLeaves,
  parallelTransactionPlan,
  sequentialTransactionPlan,
  singleTransactionPlan
} from "@solana/kit";
import { executeTransactionPlanSequentially } from "./sequential-plan-execution";
import { isPreflightRejection, PREFLIGHT_FAILURE_ERROR_CODE } from "../../components/workspace/transaction-plan-outcome";

// These tests run the REAL `@solana/kit` plan executor. Mocking it hid the bug: the
// concurrent executor started "verify proof" before "create proof account" had landed.

type Step = "create" | "verify" | "other";
const message = (step: Step) => ({ step }) as never;
const stepOf = (value: unknown) => (value as { step: Step }).step;

const FINALIZED = { confirmationStatus: "finalized", err: null };

/**
 * A chain where "verify" can only be simulated once "create" has landed, and
 * where landing takes time. Sending "verify" earlier is rejected by preflight.
 */
function fakeChain(options: {
  statusOf?: (signature: string) => unknown;
  extraSendFailures?: Partial<Record<Step, Error[]>>;
} = {}) {
  const sent: string[] = [];
  const landed = new Set<string>();
  const failures = { ...options.extraSendFailures };
  const rpc = {
    sendTransaction: (wire: string) => ({
      send: async () => {
        const step = wire as Step;
        const queued = failures[step]?.shift();
        if (queued) throw queued;
        if (step === "verify" && !landed.has("create")) {
          throw Object.assign(new Error("Transaction simulation failed: custom program error"), {
            context: { __code: PREFLIGHT_FAILURE_ERROR_CODE, logs: ["Program log: proof context not initialized"] }
          });
        }
        sent.push(step);
        if (step === "create") await new Promise((resolve) => setTimeout(resolve, 25));
        landed.add(step);
        return `sig-${step}`;
      }
    }),
    getSignatureStatuses: ([signature]: string[]) => ({
      send: async () => ({
        value: [options.statusOf ? options.statusOf(signature!) : landed.has(signature!.replace("sig-", "")) ? FINALIZED : null]
      })
    })
  };
  return { rpc: rpc as never, sent };
}

const prepare = async (planned: unknown) => ({ wire: stepOf(planned) });
const createThenVerify = () =>
  sequentialTransactionPlan([singleTransactionPlan(message("create")), singleTransactionPlan(message("verify"))]);

describe("executeTransactionPlanSequentially", () => {
  it("sends verify only after create has landed (the proof-account race)", async () => {
    const chain = fakeChain();
    const result = await executeTransactionPlanSequentially({
      rpc: chain.rpc, plan: createThenVerify(), prepare: (planned) => prepare(planned), timeoutMs: 5_000
    });
    expect(result).toEqual({
      successful: true, pending: false, signatures: ["sig-create", "sig-verify"], trackingFailed: false
    });
    expect(chain.sent).toEqual(["create", "verify"]);
  });

  it("documents the bug: the concurrent executor sends verify first, so the same plan fails", async () => {
    const chain = fakeChain();
    const executor = createTransactionPlanExecutorWithConcurrentLeaves({
      executeTransactionMessage: async (_context, planned) => {
        const prepared = await prepare(planned);
        const signature = await (chain.rpc as never as { sendTransaction: (wire: string) => { send: () => Promise<string> } })
          .sendTransaction(prepared.wire).send();
        return { signature: signature as never };
      }
    });
    await expect(executor(createThenVerify())).rejects.toThrow();
  });

  it("still runs the independent branches of a parallel plan together", async () => {
    const order: string[] = [];
    const chain = fakeChain();
    const result = await executeTransactionPlanSequentially({
      rpc: chain.rpc,
      plan: parallelTransactionPlan([singleTransactionPlan(message("create")), singleTransactionPlan(message("other"))]),
      prepare: async (planned) => { order.push(stepOf(planned)); return { wire: stepOf(planned) }; },
      timeoutMs: 5_000
    });
    expect(result.successful).toBe(true);
    expect(order.sort()).toEqual(["create", "other"]);
  });

  it("reports pending, not failure, when a step does not confirm within the budget", async () => {
    const chain = fakeChain({ statusOf: () => ({ confirmationStatus: "processed", err: null }) });
    const result = await executeTransactionPlanSequentially({
      rpc: chain.rpc, plan: createThenVerify(), prepare: (planned) => prepare(planned), timeoutMs: 0
    });
    expect(result).toMatchObject({ successful: false, pending: true, signatures: ["sig-create"] });
    // The dependent step must not be sent while the first is unconfirmed.
    expect(chain.sent).toEqual(["create"]);
  });

  it("reports a step that failed at finality as a failure, not an exception", async () => {
    const chain = fakeChain({
      statusOf: () => ({ confirmationStatus: "finalized", err: { InstructionError: [0, "Custom"] } })
    });
    const result = await executeTransactionPlanSequentially({
      rpc: chain.rpc, plan: createThenVerify(), prepare: (planned) => prepare(planned), timeoutMs: 5_000
    });
    expect(result).toMatchObject({ successful: false, pending: false, trackingFailed: false });
    expect(chain.sent).toEqual(["create"]);
  });

  it("settles every submitted signature before answering, so a late success is not rolled back", async () => {
    const chain = fakeChain({
      statusOf: (signature) => signature === "sig-create" ? FINALIZED : { confirmationStatus: "confirmed", err: null }
    });
    const result = await executeTransactionPlanSequentially({
      rpc: chain.rpc, plan: createThenVerify(), prepare: (planned) => prepare(planned), timeoutMs: 0
    });
    // Both steps confirmed, but verify is not final yet: the plan is pending, never "successful".
    expect(result).toMatchObject({ successful: false, pending: true });
    expect(result.signatures).toEqual(["sig-create", "sig-verify"]);
  });

  it("stops before the next step when a submitted signature could not be recorded", async () => {
    const chain = fakeChain();
    const onSubmitted = vi.fn(async () => { throw new Error("database unavailable"); });
    const result = await executeTransactionPlanSequentially({
      rpc: chain.rpc, plan: createThenVerify(), prepare: (planned) => prepare(planned), onSubmitted, timeoutMs: 5_000
    });
    expect(result).toMatchObject({ successful: false, pending: false, trackingFailed: true, signatures: ["sig-create"] });
    expect(chain.sent).toEqual(["create"]);
  });

  it("records each signature as soon as it exists", async () => {
    const chain = fakeChain();
    const recorded: string[] = [];
    await executeTransactionPlanSequentially({
      rpc: chain.rpc, plan: createThenVerify(), prepare: (planned) => prepare(planned),
      onSubmitted: async (signature) => { recorded.push(signature); }, timeoutMs: 5_000
    });
    expect(recorded).toEqual(["sig-create", "sig-verify"]);
  });

  it("rethrows a preflight rejection unchanged for the caller to classify, with nothing submitted", async () => {
    const rejected = Object.assign(new Error("Transaction simulation failed: custom program error 0x1"), {
      context: { __code: PREFLIGHT_FAILURE_ERROR_CODE }
    });
    const chain = fakeChain({ extraSendFailures: { create: [rejected] } });
    const error = await executeTransactionPlanSequentially({
      rpc: chain.rpc, plan: createThenVerify(), prepare: (planned) => prepare(planned), timeoutMs: 5_000
    }).then(() => null, (thrown) => thrown);
    expect(error).not.toBeNull();
    expect(isPreflightRejection(error)).toBe(true);
    expect(chain.sent).toEqual([]);
  });

  it("retries a preflight miss caused by a node a moment behind", async () => {
    const lagging = Object.assign(new Error("Transaction simulation failed"), {
      context: { __code: PREFLIGHT_FAILURE_ERROR_CODE, logs: ["AccountNotFound"] }
    });
    const chain = fakeChain({ extraSendFailures: { create: [lagging] } });
    const result = await executeTransactionPlanSequentially({
      rpc: chain.rpc, plan: createThenVerify(), prepare: (planned) => prepare(planned), timeoutMs: 5_000
    });
    expect(result.successful).toBe(true);
  });

  it("rejects a transaction whose signature differs from the one that was recorded beforehand", async () => {
    const chain = fakeChain();
    const mismatch = new Error("signature mismatch");
    const error = await executeTransactionPlanSequentially({
      rpc: chain.rpc,
      plan: createThenVerify(),
      prepare: async (planned) => ({ wire: stepOf(planned), expectedSignature: "sig-somebody-else" }),
      signatureMismatchError: () => mismatch,
      timeoutMs: 5_000
    }).then(() => null, (thrown) => thrown);
    expect((error as { cause?: unknown }).cause).toBe(mismatch);
  });
});
