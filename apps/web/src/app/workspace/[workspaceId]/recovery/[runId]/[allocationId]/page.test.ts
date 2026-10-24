import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWorkspacePayrollRun: vi.fn(),
  getWorkspacePageContext: vi.fn(),
  loadPayloreConfig: vi.fn(),
  getFinalizedPayrollClaimState: vi.fn(),
  recoveryProps: null as Record<string, unknown> | null
}));

vi.mock("@paylore/database", () => ({
  getWorkspacePayrollRun: mocks.getWorkspacePayrollRun
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
  mocks.getWorkspacePageContext.mockResolvedValue({
    db,
    workspace: { role: "organization_admin", workspaceName: "Workspace A" },
    session: { userId: "admin-a", walletAddress: "admin-wallet" }
  });
  mocks.getWorkspacePayrollRun.mockResolvedValue(payroll);
  mocks.loadPayloreConfig.mockReturnValue({
    PAYLORE_PAYROLL_PROGRAM_ID: "paylore-program"
  });
  mocks.getFinalizedPayrollClaimState.mockResolvedValue("unclaimed");
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
      amountCommitment: allocation.amountCommitment
    });
    expect(html).toContain("Financial recovery is unavailable");
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
    mocks.getFinalizedPayrollClaimState.mockResolvedValue("claimed");
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
