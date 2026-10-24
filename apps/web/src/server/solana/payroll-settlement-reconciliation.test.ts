import { describe, expect, it, vi } from "vitest";
import {
  reconcileFinalizedSettlement,
  type FinalizedSettlementDependencies
} from "./payroll-settlement-reconciliation";

function dependencies(overrides: Partial<FinalizedSettlementDependencies> = {}) {
  return {
    getFinality: vi.fn().mockResolvedValue("finalized"),
    verifyFinalizedTransaction: vi.fn().mockResolvedValue(undefined),
    readFinalizedSourceAvailable: vi.fn().mockResolvedValue("3750"),
    readFinalizedClaimState: vi.fn().mockResolvedValue("claimed"),
    finalizeClaimed: vi.fn().mockResolvedValue("finalized"),
    attachSignature: vi.fn().mockResolvedValue("attached"),
    recordLedger: vi.fn().mockResolvedValue("claimed"),
    cleanupProofContexts: vi.fn().mockResolvedValue(true),
    ...overrides
  } satisfies FinalizedSettlementDependencies;
}

const settlement = {
  signature: "settlement-signature",
  amountBaseUnits: "1250",
  sourceAvailableBefore: "5000",
  proofDurationMs: 28
};

describe("finalized confidential payroll settlement reconciliation", () => {
  it("records a claim only after finality, transaction/account verification and exact debit", async () => {
    const deps = dependencies();
    const result = await reconcileFinalizedSettlement(settlement, deps);
    expect(result).toMatchObject({
      status: "claimed",
      signature: settlement.signature,
      amountBaseUnits: settlement.amountBaseUnits
    });
    expect(deps.getFinality).toHaveBeenCalledOnce();
    expect(deps.verifyFinalizedTransaction).toHaveBeenCalledOnce();
    expect(deps.readFinalizedSourceAvailable).toHaveBeenCalledOnce();
    expect(deps.readFinalizedClaimState).toHaveBeenCalledOnce();
    expect(deps.attachSignature).toHaveBeenCalledOnce();
    expect(deps.recordLedger).toHaveBeenCalledOnce();
    expect(deps.cleanupProofContexts).toHaveBeenCalledOnce();
  });

  it.each(["pending", "failed"] as const)("never records success when transfer finality is %s", async (finality) => {
    const deps = dependencies({ getFinality: vi.fn().mockResolvedValue(finality) });
    await expect(reconcileFinalizedSettlement(settlement, deps)).resolves.toMatchObject({ status: "pending" });
    expect(deps.verifyFinalizedTransaction).not.toHaveBeenCalled();
    expect(deps.attachSignature).not.toHaveBeenCalled();
    expect(deps.recordLedger).not.toHaveBeenCalled();
  });

  it("does not record success when finalized transaction verification fails", async () => {
    const deps = dependencies({
      verifyFinalizedTransaction: vi.fn().mockRejectedValue(new Error("transaction mismatch"))
    });
    await expect(reconcileFinalizedSettlement(settlement, deps)).rejects.toThrow("transaction mismatch");
    expect(deps.attachSignature).not.toHaveBeenCalled();
    expect(deps.recordLedger).not.toHaveBeenCalled();
  });

  it.each([
    ["too small", "4000"],
    ["too large", "3749"],
    ["increased balance", "5001"]
  ])("does not record success when source debit is %s", async (_label, after) => {
    const deps = dependencies({ readFinalizedSourceAvailable: vi.fn().mockResolvedValue(after) });
    await expect(reconcileFinalizedSettlement(settlement, deps)).resolves.toMatchObject({ status: "pending" });
    expect(deps.readFinalizedClaimState).not.toHaveBeenCalled();
    expect(deps.recordLedger).not.toHaveBeenCalled();
  });

  it("finalizes a pending Claim PDA only after the exact debit is reconciled", async () => {
    const deps = dependencies({
      readFinalizedClaimState: vi.fn()
        .mockResolvedValueOnce("settlement_pending")
        .mockResolvedValueOnce("claimed")
    });
    await expect(reconcileFinalizedSettlement(settlement, deps)).resolves.toMatchObject({ status: "claimed" });
    expect(deps.finalizeClaimed).toHaveBeenCalledOnce();
    expect(deps.readFinalizedClaimState).toHaveBeenCalledTimes(2);
    expect(deps.finalizeClaimed.mock.invocationCallOrder[0]).toBeGreaterThan(
      deps.readFinalizedSourceAvailable.mock.invocationCallOrder[0]
    );
  });

  it.each(["pending", "failed"] as const)("keeps a Claim PDA pending when finalization is %s", async (finality) => {
    const deps = dependencies({
      readFinalizedClaimState: vi.fn().mockResolvedValue("settlement_pending"),
      finalizeClaimed: vi.fn().mockResolvedValue(finality)
    });
    await expect(reconcileFinalizedSettlement(settlement, deps)).resolves.toMatchObject({ status: "pending" });
    expect(deps.attachSignature).not.toHaveBeenCalled();
    expect(deps.recordLedger).not.toHaveBeenCalled();
  });

  it("rejects a conflicting claim state without attaching a signature or recording a ledger entry", async () => {
    const deps = dependencies({ readFinalizedClaimState: vi.fn().mockResolvedValue("recovered") });
    await expect(reconcileFinalizedSettlement(settlement, deps)).resolves.toMatchObject({ status: "state_conflict" });
    expect(deps.attachSignature).not.toHaveBeenCalled();
    expect(deps.recordLedger).not.toHaveBeenCalled();
  });

  it("treats signature attachment conflicts as pending and does not post a ledger entry", async () => {
    const deps = dependencies({ attachSignature: vi.fn().mockResolvedValue("conflict") });
    await expect(reconcileFinalizedSettlement(settlement, deps)).resolves.toMatchObject({ status: "pending" });
    expect(deps.recordLedger).not.toHaveBeenCalled();
  });

  it("keeps ledger conflicts non-successful", async () => {
    const deps = dependencies({ recordLedger: vi.fn().mockResolvedValue("conflict") });
    await expect(reconcileFinalizedSettlement(settlement, deps)).resolves.toMatchObject({ status: "pending" });
    expect(deps.cleanupProofContexts).not.toHaveBeenCalled();
  });

  it("reports an idempotent replay without double-recording the claim", async () => {
    const deps = dependencies({ recordLedger: vi.fn().mockResolvedValue("duplicate") });
    await expect(reconcileFinalizedSettlement(settlement, deps)).resolves.toMatchObject({ status: "already_settled" });
    expect(deps.recordLedger).toHaveBeenCalledOnce();
  });

  it("does not claim proof cleanup succeeded when owned-context cleanup fails", async () => {
    const deps = dependencies({ cleanupProofContexts: vi.fn().mockResolvedValue(false) });
    await expect(reconcileFinalizedSettlement(settlement, deps)).resolves.toMatchObject({
      status: "claimed",
      warning: "proof_context_cleanup_pending"
    });
  });
});
