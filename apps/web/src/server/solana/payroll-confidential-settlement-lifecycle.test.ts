import { beforeEach, describe, expect, it, vi } from "vitest";
import { address, getAddressEncoder } from "@solana/kit";
import { ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS } from "@solana-program/zk-elgamal-proof";

const mocks = vi.hoisted(() => ({
  fetchEncodedAccount: vi.fn(),
  createTransactionPlanner: vi.fn(),
  createTransactionPlanExecutor: vi.fn(),
  clearPayrollSettlementProofContexts: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@paylore/database", () => ({
  appendPayrollSettlementContextSignature: vi.fn(),
  attachPayrollSettlementSignature: vi.fn(),
  beginPayrollSettlementAttempt: vi.fn(),
  clearPayrollSettlementProofContexts: mocks.clearPayrollSettlementProofContexts,
  getContributorConfidentialAccount: vi.fn(),
  getPayrollClaimCreationEvidence: vi.fn(),
  getWorkspacePayrollRun: vi.fn(),
  getWorkspaceReserve: vi.fn(),
  recordVerifiedPayrollClaimSettlement: vi.fn(),
  releaseFailedPayrollSettlementAttempt: vi.fn(),
  releaseUnsubmittedPayrollSettlementAttempt: vi.fn(),
  setPayrollSettlementProofContexts: vi.fn(),
  updatePendingPayrollSettlementBalanceSnapshot: vi.fn()
}));
vi.mock("@solana/kit", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchEncodedAccount: mocks.fetchEncodedAccount,
  createTransactionPlanner: mocks.createTransactionPlanner,
  createTransactionPlanExecutor: mocks.createTransactionPlanExecutor
}));

import { cleanupProofContexts, proofSetupFinality } from "./payroll-confidential-settlement";

type Status = { confirmationStatus?: string | null; err?: unknown } | null;
function rpcWithStatuses(statuses: Status[]) {
  const queue = [...statuses];
  const getSignatureStatuses = vi.fn(() => ({
    send: vi.fn().mockResolvedValue({ value: [queue.shift() ?? null] })
  }));
  return { getSignatureStatuses };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.createTransactionPlanner.mockImplementation(() => async (plan: unknown) => plan);
  mocks.createTransactionPlanExecutor.mockImplementation(() => async () => {
    throw new Error("proof context close failed");
  });
});

describe("confidential proof setup finality", () => {
  it("accepts setup only when every proof-context transaction is finalized successfully", async () => {
    const rpc = rpcWithStatuses([
      { confirmationStatus: "finalized", err: null },
      { confirmationStatus: "finalized", err: null },
      { confirmationStatus: "finalized", err: null }
    ]);
    await expect(proofSetupFinality(rpc as never, ["setup-a", "setup-b", "setup-c"])).resolves.toBe("finalized");
    expect(rpc.getSignatureStatuses).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["missing status", null],
    ["processed status", { confirmationStatus: "processed", err: null }],
    ["confirmed status", { confirmationStatus: "confirmed", err: null }]
  ])("keeps proof setup pending for %s", async (_label, status) => {
    const rpc = rpcWithStatuses([status as Status]);
    await expect(proofSetupFinality(rpc as never, ["setup-a"])).resolves.toBe("pending");
  });

  it("reports a finalized proof setup failure instead of treating it as ready", async () => {
    const rpc = rpcWithStatuses([
      { confirmationStatus: "finalized", err: { InstructionError: [0, "Custom"] } }
    ]);
    await expect(proofSetupFinality(rpc as never, ["setup-a"])).resolves.toBe("failed");
  });

  it("does not discard earlier successful proof setup when a later context is pending", async () => {
    const rpc = rpcWithStatuses([
      { confirmationStatus: "finalized", err: null },
      { confirmationStatus: "confirmed", err: null }
    ]);
    await expect(proofSetupFinality(rpc as never, ["setup-a", "setup-b"])).resolves.toBe("pending");
    expect(rpc.getSignatureStatuses).toHaveBeenCalledTimes(2);
  });

  it("preserves an earlier finalized setup signature when a later setup transaction failed", async () => {
    const rpc = rpcWithStatuses([
      { confirmationStatus: "finalized", err: null },
      { confirmationStatus: "finalized", err: { InstructionError: [0, "Custom"] } }
    ]);
    await expect(proofSetupFinality(rpc as never, ["setup-a", "setup-b"])).resolves.toBe("failed");
    expect(rpc.getSignatureStatuses).toHaveBeenCalledTimes(2);
  });

  it("keeps proof setup pending when RPC status lookup fails", async () => {
    const rpc = {
      getSignatureStatuses: vi.fn(() => ({
        send: vi.fn().mockRejectedValue(new Error("RPC unavailable"))
      }))
    };
    await expect(proofSetupFinality(rpc as never, ["setup-a"])).resolves.toBe("pending");
  });

  it("does not treat an empty signature set as finalized", async () => {
    const rpc = rpcWithStatuses([]);
    await expect(proofSetupFinality(rpc as never, [])).resolves.toBe("pending");
    expect(rpc.getSignatureStatuses).not.toHaveBeenCalled();
  });
});

describe("confidential proof-context cleanup", () => {
  // The Gas Tank pays for and owns proof contexts; the reserve only signs. A context's first
  // 32 bytes are its authority, and an all-zero context was never initialised.
  const gasTank = { address: "Vote111111111111111111111111111111111111111" };
  const reserve = { address: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" };
  const contextData = (owner: string) => {
    const data = new Uint8Array(33);
    data.set(getAddressEncoder().encode(address(owner)));
    return data;
  };
  const gasTankContext = { exists: true, owner: ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS, data: contextData(gasTank.address) };
  const uninitializedContext = { exists: true, owner: ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS, data: new Uint8Array(297) };
  const cleanupInput = {
    workspaceId: "workspace-a",
    runId: "run-a",
    allocationId: "allocation-a",
    addresses: ["ComputeBudget111111111111111111111111111111", "ComputeBudget111111111111111111111111111111", "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"]
  };

  it("clears durable context tracking only after every context is already absent", async () => {
    mocks.fetchEncodedAccount.mockResolvedValue({ exists: false });
    mocks.clearPayrollSettlementProofContexts.mockResolvedValue(true);
    const result = await cleanupProofContexts({} as never, {} as never, reserve as never, gasTank as never, cleanupInput);
    expect(result).toBe(true);
    expect(mocks.fetchEncodedAccount).toHaveBeenCalledTimes(2);
    expect(mocks.clearPayrollSettlementProofContexts).toHaveBeenCalledOnce();
  });

  it("records a context owned by an unexpected program as a leftover instead of blocking cleanup", async () => {
    mocks.fetchEncodedAccount.mockResolvedValue({ exists: true, owner: "unexpected-program" });
    mocks.clearPayrollSettlementProofContexts.mockResolvedValue(true);
    const result = await cleanupProofContexts({} as never, {} as never, reserve as never, gasTank as never, cleanupInput);
    expect(result).toBe(true);
    expect(mocks.fetchEncodedAccount).toHaveBeenCalledTimes(2);
    expect(mocks.createTransactionPlanExecutor).not.toHaveBeenCalled();
    expect(mocks.clearPayrollSettlementProofContexts).toHaveBeenCalledOnce();
  });

  it("resolves an all-zero (never initialised) proof context without trying to close it", async () => {
    // The stuck production allocation: verify raced ahead of create and left an all-zero context
    // whose authority is the zero address, so no one can ever close it.
    mocks.fetchEncodedAccount.mockResolvedValue(uninitializedContext);
    mocks.clearPayrollSettlementProofContexts.mockResolvedValue(true);
    const result = await cleanupProofContexts({} as never, {} as never, reserve as never, gasTank as never, cleanupInput);
    expect(result).toBe(true);
    expect(mocks.createTransactionPlanExecutor).not.toHaveBeenCalled();
    expect(mocks.clearPayrollSettlementProofContexts).toHaveBeenCalledOnce();
  });

  it("still closes the closable contexts when another one is all-zero", async () => {
    mocks.fetchEncodedAccount
      .mockResolvedValueOnce(uninitializedContext)
      .mockResolvedValueOnce(gasTankContext);
    mocks.createTransactionPlanExecutor.mockImplementation(() => async () => ({
      successful: true, pending: false, signatures: ["close-signature"], trackingFailed: false
    }));
    mocks.clearPayrollSettlementProofContexts.mockResolvedValue(true);
    const result = await cleanupProofContexts({} as never, {} as never, reserve as never, gasTank as never, cleanupInput);
    expect(result).toBe(true);
    expect(mocks.createTransactionPlanExecutor).toHaveBeenCalledOnce();
  });


  it("closes every owned context before clearing durable tracking", async () => {
    mocks.fetchEncodedAccount.mockResolvedValue(gasTankContext);
    mocks.createTransactionPlanExecutor.mockImplementation(() => async () => ({
      successful: true,
      pending: false,
      signatures: ["close-signature"],
      trackingFailed: false
    }));
    mocks.clearPayrollSettlementProofContexts.mockResolvedValue(true);
    const result = await cleanupProofContexts({} as never, {} as never, reserve as never, gasTank as never, cleanupInput);
    expect(result).toBe(true);
    expect(mocks.fetchEncodedAccount).toHaveBeenCalledTimes(2);
    expect(mocks.createTransactionPlanExecutor).toHaveBeenCalledTimes(2);
    expect(mocks.clearPayrollSettlementProofContexts).toHaveBeenCalledOnce();
  });


  it.each([
    ["pending", { successful: false, pending: true, signatures: ["close-signature"], trackingFailed: false }],
    ["signature tracking failure", { successful: false, pending: false, signatures: ["close-signature"], trackingFailed: true }]
  ] as const)("retains durable context records when close is %s", async (_label, _outcome) => {
    mocks.fetchEncodedAccount.mockResolvedValue(gasTankContext);
    mocks.createTransactionPlanExecutor.mockImplementation(() => async () => {
      throw new Error(`${_label}: close did not finalize`);
    });
    const result = await cleanupProofContexts({} as never, {} as never, reserve as never, gasTank as never, cleanupInput);
    expect(result).toBe(false);
    expect(mocks.clearPayrollSettlementProofContexts).not.toHaveBeenCalled();
  });

  it("retains tracked contexts when the durable clear operation cannot be committed", async () => {
    mocks.fetchEncodedAccount.mockResolvedValue({ exists: false });
    mocks.clearPayrollSettlementProofContexts.mockResolvedValue(false);
    await expect(cleanupProofContexts({} as never, {} as never, reserve as never, gasTank as never, cleanupInput))
      .resolves.toBe(false);
    expect(mocks.clearPayrollSettlementProofContexts).toHaveBeenCalledOnce();
  });

  it("continues checking remaining contexts after one owned-context close fails", async () => {
    mocks.fetchEncodedAccount.mockResolvedValue(gasTankContext);
    mocks.createTransactionPlanExecutor
      .mockImplementationOnce(() => async () => { throw new Error("first close failed"); })
      .mockImplementationOnce(() => async () => ({
        successful: true, pending: false, signatures: ["second-close"], trackingFailed: false
      }));
    const result = await cleanupProofContexts({} as never, {} as never, reserve as never, gasTank as never, cleanupInput);
    expect(result).toBe(false);
    expect(mocks.fetchEncodedAccount).toHaveBeenCalledTimes(2);
    expect(mocks.createTransactionPlanExecutor).toHaveBeenCalledTimes(2);
    expect(mocks.clearPayrollSettlementProofContexts).not.toHaveBeenCalled();
  });

  it("keeps durable tracking when closing an owned proof context fails", async () => {
    mocks.fetchEncodedAccount.mockResolvedValue(gasTankContext);
    const result = await cleanupProofContexts({} as never, {} as never, reserve as never, gasTank as never, cleanupInput);
    expect(result).toBe(false);
    expect(mocks.clearPayrollSettlementProofContexts).not.toHaveBeenCalled();
  });

  const successfulClose = { successful: true, pending: false, signatures: ["close-signature"], trackingFailed: false };

  function captureClosePlans() {
    const plans: Array<{ instruction?: { accounts?: Array<{ address: string; signer?: { address: string } }> } }> = [];
    mocks.createTransactionPlanExecutor.mockImplementation(() => async (plan: never) => {
      plans.push(plan);
      return successfulClose;
    });
    return plans;
  }

  it("closes a Gas Tank owned context with the Gas Tank as authority and refunds its rent to the Gas Tank", async () => {
    mocks.fetchEncodedAccount.mockResolvedValue(gasTankContext);
    const plans = captureClosePlans();
    mocks.clearPayrollSettlementProofContexts.mockResolvedValue(true);
    await expect(cleanupProofContexts({} as never, {} as never, reserve as never, gasTank as never, cleanupInput))
      .resolves.toBe(true);
    expect(plans).toHaveLength(2);
    for (const plan of plans) {
      const [, destination, authority] = plan.instruction!.accounts!;
      expect(authority!.address).toBe(gasTank.address);
      expect(destination!.address).toBe(gasTank.address);
    }
  });

  it("closes a context owned by the reserve authority with the reserve as authority", async () => {
    const reserveBytes = new Uint8Array(33);
    reserveBytes.set(getAddressEncoder().encode(address(reserve.address)));
    mocks.fetchEncodedAccount.mockResolvedValue({ ...gasTankContext, data: reserveBytes });
    const plans = captureClosePlans();
    mocks.clearPayrollSettlementProofContexts.mockResolvedValue(true);
    await expect(cleanupProofContexts({} as never, {} as never, reserve as never, gasTank as never, cleanupInput))
      .resolves.toBe(true);
    expect(plans[0]!.instruction!.accounts![2]!.address).toBe(reserve.address);
  });

  it("sends nothing and records a leftover when a context belongs to neither signer", async () => {
    const foreign = new Uint8Array(33).fill(9);
    mocks.fetchEncodedAccount.mockResolvedValue({ ...gasTankContext, data: foreign });
    mocks.clearPayrollSettlementProofContexts.mockResolvedValue(true);
    const plans = captureClosePlans();
    await expect(cleanupProofContexts({} as never, {} as never, reserve as never, gasTank as never, cleanupInput))
      .resolves.toBe(true);
    expect(plans).toHaveLength(0);
    expect(mocks.clearPayrollSettlementProofContexts).toHaveBeenCalledOnce();
  });

  it("sends nothing and records a leftover when account data cannot be parsed", async () => {
    mocks.fetchEncodedAccount.mockResolvedValue({ exists: true, owner: ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS });
    mocks.clearPayrollSettlementProofContexts.mockResolvedValue(true);
    const plans = captureClosePlans();
    await expect(cleanupProofContexts({} as never, {} as never, reserve as never, gasTank as never, cleanupInput))
      .resolves.toBe(true);
    expect(plans).toHaveLength(0);
  });

  it("keeps tracking when the account cannot be fetched at all", async () => {
    mocks.fetchEncodedAccount.mockRejectedValue(new Error("RPC unavailable"));
    const plans = captureClosePlans();
    await expect(cleanupProofContexts({} as never, {} as never, reserve as never, gasTank as never, cleanupInput))
      .resolves.toBe(false);
    expect(plans).toHaveLength(0);
    expect(mocks.clearPayrollSettlementProofContexts).not.toHaveBeenCalled();
  });
});
