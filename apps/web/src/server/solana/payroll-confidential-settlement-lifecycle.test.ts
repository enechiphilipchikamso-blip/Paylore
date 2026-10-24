import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchEncodedAccount: vi.fn(),
  createTransactionPlanner: vi.fn(),
  createTransactionPlanExecutorWithConcurrentLeaves: vi.fn(),
  clearPayrollSettlementProofContexts: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("@paylore/database", () => ({
  clearPayrollSettlementProofContexts: mocks.clearPayrollSettlementProofContexts
}));
vi.mock("@solana/kit", async (importOriginal) => ({
  ...(await importOriginal()),
  fetchEncodedAccount: mocks.fetchEncodedAccount,
  createTransactionPlanner: mocks.createTransactionPlanner,
  createTransactionPlanExecutorWithConcurrentLeaves: mocks.createTransactionPlanExecutorWithConcurrentLeaves
}));

import { cleanupProofContexts, proofSetupFinality } from "./payroll-confidential-settlement";

type Status = { confirmationStatus?: string | null; err?: unknown } | null;
function rpcWithStatuses(statuses: Status[]) {
  return { getSignatureStatuses: vi.fn().mockResolvedValue({ value: statuses }) };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.createTransactionPlanner.mockImplementation(() => async (plan: unknown) => plan);
  mocks.createTransactionPlanExecutorWithConcurrentLeaves.mockImplementation(() => async () => {
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

  it("keeps proof setup pending when RPC status lookup fails", async () => {
    const rpc = {
      getSignatureStatuses: vi.fn().mockRejectedValue(new Error("RPC unavailable"))
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
  const cleanupInput = {
    workspaceId: "workspace-a",
    runId: "run-a",
    allocationId: "allocation-a",
    addresses: ["ComputeBudget111111111111111111111111111111", "ComputeBudget111111111111111111111111111111", "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"]
  };

  it("clears durable context tracking only after every context is already absent", async () => {
    mocks.fetchEncodedAccount.mockResolvedValue({ exists: false });
    mocks.clearPayrollSettlementProofContexts.mockResolvedValue(true);
    const result = await cleanupProofContexts({} as never, {} as never, { address: "reserve" } as never, cleanupInput);
    expect(result).toBe(true);
    expect(mocks.fetchEncodedAccount).toHaveBeenCalledTimes(2);
    expect(mocks.clearPayrollSettlementProofContexts).toHaveBeenCalledOnce();
  });

  it("retains durable tracking when a context is owned by an unexpected program", async () => {
    mocks.fetchEncodedAccount.mockResolvedValue({ exists: true, owner: "unexpected-program" });
    const result = await cleanupProofContexts({} as never, {} as never, { address: "reserve" } as never, cleanupInput);
    expect(result).toBe(false);
    expect(mocks.fetchEncodedAccount).toHaveBeenCalledOnce();
    expect(mocks.clearPayrollSettlementProofContexts).not.toHaveBeenCalled();
  });


  it("keeps durable tracking when closing an owned proof context fails", async () => {
    mocks.fetchEncodedAccount.mockResolvedValue({
      exists: true,
      owner: "ZkE1Gama1Proof11111111111111111111111111111"
    });
    const result = await cleanupProofContexts({} as never, {} as never, { address: "11111111111111111111111111111111" } as never, cleanupInput);
    expect(result).toBe(false);
    expect(mocks.clearPayrollSettlementProofContexts).not.toHaveBeenCalled();
  });
});
