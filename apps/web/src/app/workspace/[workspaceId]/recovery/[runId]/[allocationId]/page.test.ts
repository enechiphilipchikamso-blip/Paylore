import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWorkspacePayrollRun: vi.fn(),
  getPayrollClaimEscrow: vi.fn(),
  getWorkspacePageContext: vi.fn(),
  loadPayloreConfig: vi.fn(),
  getFinalizedPayrollClaimState: vi.fn(),
  recoveryProps: null as Record<string, unknown> | null,
  fundingProps: null as Record<string, unknown> | null
}));

vi.mock("@paylore/database", () => ({
  getWorkspacePayrollRun: mocks.getWorkspacePayrollRun,
  getPayrollClaimEscrow: mocks.getPayrollClaimEscrow
}));
vi.mock("../../../../../../server/workspace-page-context", () => ({
  getWorkspacePageContext: mocks.getWorkspacePageContext
}));
vi.mock("../../../../../../server/config", () => ({
  loadPayloreConfig: mocks.loadPayloreConfig
}));
vi.mock("../../../../../../server/solana/payroll-program-verification", () => ({
  getFinalizedPayrollClaimState: mocks.getFinalizedPayrollClaimState
}));
vi.mock("../../../../../../components/workspace/PayrollRecoveryAction", () => ({
  PayrollRecoveryAction: (props: Record<string, unknown>) => {
    mocks.recoveryProps = props;
    return createElement("div", { "data-testid": "recovery-action" }, "Recovery action");
  }
}));
vi.mock("../../../../../../components/workspace/PayrollClaimEscrowFundingAction", () => ({
  PayrollClaimEscrowFundingAction: (props: Record<string, unknown>) => {
    mocks.fundingProps = props;
    return createElement("div", { "data-testid": "escrow-funding-action" }, "Fund claim escrow");
  }
}));
vi.mock("../../../../../../components/workspace/WorkspaceNavigation", () => ({
  WorkspaceNavigation: () => null,
  WorkspaceLegalFooter: () => null
}));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); }
}));
vi.mock("next/link", () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) =>
    createElement("a", { href }, children)
}));

import RecoveryDetailPage from "./page";

const db = { tag: "test-db" };
const allocation = {
  id: "allocation-a",
  contributorId: "contributor-a",
  contributorWalletAddress: "wallet-a",
  amountBaseUnits: "1250000",
  claimId: "01".repeat(32),
  amountCommitment: "33".repeat(32),
  claimAddress: "claim-pda-a",
  status: "unclaimed",
  transactionSignature: "claim-creation-signature-a",
  settlementSignature: null
};
const payroll = {
  run: {
    id: "run-a",
    createdAt: new Date("2026-10-01T00:00:00.000Z"),
    allocationCommitment: "22".repeat(32)
  },
  allocations: [allocation]
};
const params = Promise.resolve({
  workspaceId: "workspace-a",
  runId: "run-a",
  allocationId: "allocation-a"
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.recoveryProps = null;
  mocks.fundingProps = null;
  mocks.getWorkspacePageContext.mockResolvedValue({
    db,
    workspace: { role: "organization_admin", workspaceName: "Workspace A" },
    session: { userId: "admin-a", walletAddress: "admin-wallet" }
  });
  mocks.getWorkspacePayrollRun.mockResolvedValue(payroll);
  mocks.getPayrollClaimEscrow.mockResolvedValue({
    allocationId: "allocation-a",
    workspaceId: "workspace-a",
    payrollRunId: "run-a",
    claimId: allocation.claimId,
    tokenAccountAddress: "claim-escrow-a",
    status: "funded",
    amountBaseUnits: "1250000"
  });
  mocks.loadPayloreConfig.mockReturnValue({
    PAYLORE_PAYROLL_PROGRAM_ID: "paylore-program"
  });
  mocks.getFinalizedPayrollClaimState.mockResolvedValue({
    status: "unclaimed",
    escrowFunded: true
  });
});

describe("workspace payroll recovery detail", () => {
  it("renders allocation evidence and keeps financial recovery explicitly unavailable", async () => {
    const page = await RecoveryDetailPage({ params });
    const html = renderToStaticMarkup(page);

    expect(mocks.getWorkspacePayrollRun).toHaveBeenCalledWith(db, "workspace-a", "run-a");
    expect(html).toContain("Recover unclaimed payroll");
    expect(html).toContain("Allocation detail");
    expect(html).toContain("wallet-a");
    expect(html).toContain("1.25 wrapped USDC");
    expect(html).toContain("claim-pda-a");
    expect(html).toContain("claim-creation-signature-a");
    expect(html).toContain("Finalized Claim PDA state");
    expect(mocks.getFinalizedPayrollClaimState).toHaveBeenCalledWith({
      authorityAddress: "admin-wallet",
      workspaceId: "workspace-a",
      contributorAddress: "wallet-a",
      claimId: allocation.claimId,
      claimAddress: "claim-pda-a",
      allocationCommitment: payroll.run.allocationCommitment,
      amountCommitment: allocation.amountCommitment,
      escrowTokenAccount: "claim-escrow-a"
    });
    expect(html).toContain("Recovery action");
    expect(html).toContain('href="/workspace/workspace-a/recovery"');
    expect(mocks.recoveryProps).toMatchObject({
      workspaceId: "workspace-a",
      runId: "run-a",
      allocationId: "allocation-a",
      claimId: allocation.claimId,
      claimAddress: "claim-pda-a",
      contributorAddress: "wallet-a",
      walletAddress: "admin-wallet",
      programId: "paylore-program",
      canRecover: true
    });
  });

  it("denies recovery action on a claimed entitlement", async () => {
    mocks.getFinalizedPayrollClaimState.mockResolvedValue({
      status: "claimed",
      escrowFunded: true
    });
    mocks.getWorkspacePayrollRun.mockResolvedValue({
      ...payroll,
      allocations: [{ ...allocation, status: "claimed", settlementSignature: "settlement-a" }]
    });

    const page = await RecoveryDetailPage({ params });
    const html = renderToStaticMarkup(page);

    expect(html).toContain("This allocation has already been claimed and cannot be recovered by the organization.");
    expect(html).not.toContain('data-testid="recovery-action"');
    expect(mocks.recoveryProps).toBeNull();
  });

  it("reports an unclaimed but unfunded PDA and offers organization escrow funding", async () => {
    mocks.getPayrollClaimEscrow.mockResolvedValue({
      allocationId: "allocation-a",
      workspaceId: "workspace-a",
      payrollRunId: "run-a",
      claimId: allocation.claimId,
      tokenAccountAddress: "claim-escrow-a",
      status: "ready",
      amountBaseUnits: "1250000"
    });
    mocks.getFinalizedPayrollClaimState.mockResolvedValue({
      status: "unclaimed",
      escrowFunded: false
    });

    const page = await RecoveryDetailPage({ params });
    const html = renderToStaticMarkup(page);

    expect(html).toContain("Unclaimed — escrow not funded.");
    expect(html).toContain("Fund claim escrow");
    expect(html).not.toContain('data-testid="recovery-action"');
    expect(mocks.fundingProps).toEqual({
      workspaceId: "workspace-a",
      runId: "run-a",
      allocationId: "allocation-a",
      initiallyPending: false
    });
    expect(mocks.recoveryProps).toBeNull();
  });

  it("offers reconciliation rather than a new funding attempt when the Claim PDA is already funded", async () => {
    mocks.getPayrollClaimEscrow.mockResolvedValue({
      allocationId: "allocation-a",
      workspaceId: "workspace-a",
      payrollRunId: "run-a",
      claimId: allocation.claimId,
      tokenAccountAddress: "claim-escrow-a",
      status: "funding",
      amountBaseUnits: "1250000",
      fundingSignature: "funding-signature"
    });

    const page = await RecoveryDetailPage({ params });
    const html = renderToStaticMarkup(page);

    expect(html).toContain("Funded on-chain; database reconciliation pending");
    expect(html).toContain("Escrow funding is finalized on-chain but has not been reconciled in Paylore.");
    expect(mocks.fundingProps).toMatchObject({ initiallyPending: true });
    expect(mocks.recoveryProps).toBeNull();
  });

  describe("allocation held by claim escrow funding", () => {
    const escrow = (status: string, extra: Record<string, unknown> = {}) => ({
      allocationId: "allocation-a",
      workspaceId: "workspace-a",
      payrollRunId: "run-a",
      claimId: allocation.claimId,
      tokenAccountAddress: "claim-escrow-a",
      status,
      amountBaseUnits: "1250000",
      ...extra
    });
    const hold = (overrides: Record<string, unknown> = {}) => mocks.getWorkspacePayrollRun.mockResolvedValue({
      ...payroll,
      allocations: [{ ...allocation, status: "settlement_pending", updatedAt: new Date(Date.now() - 60 * 60 * 1000), ...overrides }]
    });

    it("says the hold is from funding, states the reason, and offers Check funding", async () => {
      hold();
      mocks.getPayrollClaimEscrow.mockResolvedValue(escrow("funding"));
      mocks.getFinalizedPayrollClaimState.mockResolvedValue({ status: "unclaimed", escrowFunded: false });

      const html = renderToStaticMarkup(await RecoveryDetailPage({ params }));

      expect(html).toContain("held by claim escrow funding, not by a contributor claim");
      expect(html).toContain("recorded no transfer and has stopped");
      expect(html).toContain("Check claim escrow funding");
      expect(html).not.toContain("Settlement is pending. Reconcile the existing claim transaction");
      expect(mocks.fundingProps).toMatchObject({ initiallyPending: true });
      expect(mocks.recoveryProps).toBeNull();
    });

    it("still offers Check funding when the finalized chain state cannot be read", async () => {
      hold();
      mocks.getPayrollClaimEscrow.mockResolvedValue(escrow("funding", { fundingSignature: "funding-signature" }));
      mocks.getFinalizedPayrollClaimState.mockRejectedValue(new Error("rpc unavailable"));

      const html = renderToStaticMarkup(await RecoveryDetailPage({ params }));

      expect(html).toContain("A funding transfer was submitted and its result is not verified yet.");
      expect(mocks.fundingProps).toMatchObject({ initiallyPending: true });
    });

    it("offers Check funding to release the hold once the escrow is funded", async () => {
      hold();
      mocks.getPayrollClaimEscrow.mockResolvedValue(escrow("funded", { fundingSignature: "funding-signature" }));

      const html = renderToStaticMarkup(await RecoveryDetailPage({ params }));

      expect(html).toContain("Funded; the hold on this allocation is not released yet");
      expect(mocks.fundingProps).toMatchObject({ initiallyPending: true });
      expect(mocks.recoveryProps).toBeNull();
    });

    it("leaves a contributor claim settlement alone", async () => {
      hold({ settlementSignature: "claim-settlement-signature" });
      mocks.getPayrollClaimEscrow.mockResolvedValue(escrow("settlement_pending"));
      mocks.getFinalizedPayrollClaimState.mockResolvedValue({ status: "settlement_pending", escrowFunded: true });

      const html = renderToStaticMarkup(await RecoveryDetailPage({ params }));

      expect(html).toContain("Settlement is pending. Reconcile the existing claim transaction");
      expect(html).not.toContain("held by claim escrow funding");
      expect(mocks.fundingProps).toBeNull();
    });
  });

  it("keeps an unknown or cross-run allocation out of the detail view", async () => {
    mocks.getWorkspacePayrollRun.mockResolvedValue({
      ...payroll,
      allocations: []
    });

    await expect(RecoveryDetailPage({ params })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.recoveryProps).toBeNull();
  });

  it("does not expose recovery allocation details to finance roles", async () => {
    mocks.getWorkspacePageContext.mockResolvedValue({
      db,
      workspace: { role: "finance_auditor", workspaceName: "Workspace A" },
      session: { userId: "finance-a", walletAddress: "finance-wallet" }
    });

    await expect(RecoveryDetailPage({ params })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.getWorkspacePayrollRun).not.toHaveBeenCalled();
  });
});
