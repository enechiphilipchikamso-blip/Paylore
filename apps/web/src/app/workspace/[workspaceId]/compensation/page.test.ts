import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  findWorkspaceContributorByWallet: vi.fn(),
  getContributorConfidentialAccount: vi.fn(),
  getContributorOffboardingStatus: vi.fn(),
  hasOpenContributorPayrollAllocations: vi.fn(),
  listContributorPayrollAllocations: vi.fn(),
  getWorkspacePageContext: vi.fn(),
  loadPayloreConfig: vi.fn(),
  compensationProps: null as Record<string, unknown> | null
}));

vi.mock("@paylore/database", () => ({
  findWorkspaceContributorByWallet: mocks.findWorkspaceContributorByWallet,
  getContributorConfidentialAccount: mocks.getContributorConfidentialAccount,
  getContributorOffboardingStatus: mocks.getContributorOffboardingStatus,
  hasOpenContributorPayrollAllocations: mocks.hasOpenContributorPayrollAllocations,
  listContributorPayrollAllocations: mocks.listContributorPayrollAllocations
}));
vi.mock("../../../../server/workspace-page-context", () => ({
  getWorkspacePageContext: mocks.getWorkspacePageContext
}));
vi.mock("../../../../server/config", () => ({
  loadPayloreConfig: mocks.loadPayloreConfig
}));
vi.mock("../../../../components/workspace/ContributorCompensation", () => ({
  ContributorCompensation: (props: Record<string, unknown>) => {
    mocks.compensationProps = props;
    return null;
  }
}));
vi.mock("../../../../components/workspace/WorkspaceNavigation", () => ({
  WorkspaceNavigation: () => null,
  WorkspaceLegalFooter: () => null
}));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); }
}));

import CompensationPage from "./page";

const db = { tag: "test-db" };
const context = {
  db,
  workspace: { role: "contributor", workspaceName: "Workspace A" },
  session: { userId: "user-a", walletAddress: "wallet-a" }
};
const allocation = {
  id: "allocation-a",
  runId: "run-a",
  runCreatedAt: new Date("2026-10-01T00:00:00.000Z"),
  amountBaseUnits: "1250000",
  status: "unclaimed",
  claimAddress: "claim-pda-a",
  transactionSignature: "claim-creation-signature-a",
  claimedAt: null,
  recoveredAt: null,
  settlementSignature: null
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.compensationProps = null;
  mocks.getWorkspacePageContext.mockResolvedValue(context);
  mocks.findWorkspaceContributorByWallet.mockResolvedValue({ id: "contributor-a", lifecycle: "active" });
  mocks.getContributorConfidentialAccount.mockResolvedValue({
    ownerWalletAddress: "wallet-a",
    tokenAccountAddress: "confidential-account-a",
    status: "ready",
    setupTransactionSignature: null,
    closeTransactionSignature: null
  });
  mocks.getContributorOffboardingStatus.mockResolvedValue(null);
  mocks.hasOpenContributorPayrollAllocations.mockResolvedValue(true);
  mocks.listContributorPayrollAllocations.mockResolvedValue([allocation]);
  mocks.loadPayloreConfig.mockReturnValue({
    PAYLORE_WRAPPED_USDC_MINT: "wrapped-usdc-mint",
    PAYLORE_SUBSCRIPTION_USDC_MINT: "circle-usdc-mint",
    TOKEN_WRAP_PROGRAM_ID: "token-wrap-program",
    TOKEN_WRAP_UNWRAP_ENABLED: false
  });
});

describe("contributor compensation page authorization scope", () => {
  it("loads account and allocations only for the contributor resolved from the session wallet", async () => {
    await CompensationPage({ params: Promise.resolve({ workspaceId: "workspace-a" }) });

    expect(mocks.findWorkspaceContributorByWallet).toHaveBeenCalledWith(db, "workspace-a", "wallet-a");
    expect(mocks.getContributorConfidentialAccount).toHaveBeenCalledWith(db, "workspace-a", "contributor-a");
    expect(mocks.hasOpenContributorPayrollAllocations).toHaveBeenCalledWith(db, "workspace-a", "contributor-a");
    expect(mocks.getContributorOffboardingStatus).toHaveBeenCalledWith(db, "workspace-a", "contributor-a");
    expect(mocks.listContributorPayrollAllocations).toHaveBeenCalledWith(db, "workspace-a", "contributor-a");
    expect(mocks.compensationProps).toMatchObject({
      workspaceId: "workspace-a",
      walletAddress: "wallet-a",
      allocations: [{
        id: "allocation-a",
        runId: "run-a",
        claimAddress: "claim-pda-a"
      }]
    });
  });

  it("does not read or render compensation for a wallet without a contributor association", async () => {
    mocks.findWorkspaceContributorByWallet.mockResolvedValue(null);

    await expect(CompensationPage({
      params: Promise.resolve({ workspaceId: "workspace-a" })
    })).rejects.toThrow("NEXT_NOT_FOUND");

    expect(mocks.getContributorConfidentialAccount).not.toHaveBeenCalled();
    expect(mocks.hasOpenContributorPayrollAllocations).not.toHaveBeenCalled();
    expect(mocks.getContributorOffboardingStatus).not.toHaveBeenCalled();
    expect(mocks.listContributorPayrollAllocations).not.toHaveBeenCalled();
    expect(mocks.compensationProps).toBeNull();
  });

  it("does not expose compensation after the contributor has left the workspace", async () => {
    mocks.findWorkspaceContributorByWallet.mockResolvedValue({ id: "contributor-a", lifecycle: "left" });

    await expect(CompensationPage({
      params: Promise.resolve({ workspaceId: "workspace-a" })
    })).rejects.toThrow("NEXT_NOT_FOUND");

    expect(mocks.getContributorConfidentialAccount).not.toHaveBeenCalled();
    expect(mocks.listContributorPayrollAllocations).not.toHaveBeenCalled();
  });

  it("does not render the contributor page for finance or administrator roles", async () => {
    mocks.getWorkspacePageContext.mockResolvedValue({
      ...context,
      workspace: { ...context.workspace, role: "finance" }
    });

    await expect(CompensationPage({
      params: Promise.resolve({ workspaceId: "workspace-a" })
    })).rejects.toThrow("NEXT_NOT_FOUND");

    expect(mocks.findWorkspaceContributorByWallet).not.toHaveBeenCalled();
    expect(mocks.listContributorPayrollAllocations).not.toHaveBeenCalled();
  });
});
