import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { proofSetupFinality } from "./payroll-confidential-settlement";

type Status = { confirmationStatus?: string | null; err?: unknown } | null;
function rpcWithStatuses(statuses: Status[]) {
  return { getSignatureStatuses: vi.fn().mockResolvedValue({ value: statuses }) };
}

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
