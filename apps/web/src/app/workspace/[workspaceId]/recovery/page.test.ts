import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWorkspacePayrollRecoveryQueue: vi.fn(),
  getWorkspacePageContext: vi.fn()
}));

vi.mock("@paylore/database", () => ({
  getWorkspacePayrollRecoveryQueue: mocks.getWorkspacePayrollRecoveryQueue
}));
vi.mock("../../../../server/workspace-page-context", () => ({
  getWorkspacePageContext: mocks.getWorkspacePageContext
}));
vi.mock("../../../../components/workspace/WorkspaceNavigation", () => ({
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

import RecoveryQueuePage from "./page";

const db = { tag: "test-db" };
const allocation = {
  id: "allocation-a",
  runId: "run-a",
  contributorId: "contributor-a",
  contributorWalletAddress: "wallet-a",
  amountBaseUnits: "1250000",
  claimId: "01".repeat(32),
  claimAddress: "claim-pda-a",
  status: "unclaimed",
  runCreatedAt: new Date("2026-10-01T00:00:00.000Z")
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getWorkspacePageContext.mockResolvedValue({
    db,
    workspace: { role: "organization_admin", workspaceName: "Workspace A" },
    session: { userId: "admin-a", walletAddress: "admin-wallet" }
  });
  mocks.getWorkspacePayrollRecoveryQueue.mockResolvedValue([allocation]);
});

describe("workspace payroll recovery queue", () => {
  it("renders workspace-scoped unclaimed allocations with links to their details", async () => {
    const page = await RecoveryQueuePage({
      params: Promise.resolve({ workspaceId: "workspace-a" })
    });
    const html = renderToStaticMarkup(page);

    expect(mocks.getWorkspacePageContext).toHaveBeenCalledWith(
      "workspace-a",
      "/workspace/workspace-a/recovery"
    );
    expect(mocks.getWorkspacePayrollRecoveryQueue).toHaveBeenCalledWith(db, "workspace-a");
    expect(html).toContain("Recover unclaimed payroll");
    expect(html).toContain("Recovery queue");
    expect(html).toContain("wallet-a");
    expect(html).toContain("1.25 wrapped USDC");
    expect(html).toContain("claim-pda-a");
    expect(html).toContain('href="/workspace/workspace-a/recovery/run-a/allocation-a"');
    expect(html).toContain("Financial recovery is unavailable");
  });

  it("renders an explicit empty state when no unclaimed Claim PDAs exist", async () => {
    mocks.getWorkspacePayrollRecoveryQueue.mockResolvedValue([]);

    const page = await RecoveryQueuePage({
      params: Promise.resolve({ workspaceId: "workspace-a" })
    });
    const html = renderToStaticMarkup(page);

    expect(html).toContain("No unclaimed payroll allocations are currently in the recovery queue.");
    expect(html).not.toContain("Review allocation");
  });

  it("does not query or render recovery records for finance roles", async () => {
    mocks.getWorkspacePageContext.mockResolvedValue({
      db,
      workspace: { role: "finance_auditor", workspaceName: "Workspace A" },
      session: { userId: "finance-a", walletAddress: "finance-wallet" }
    });

    await expect(RecoveryQueuePage({
      params: Promise.resolve({ workspaceId: "workspace-a" })
    })).rejects.toThrow("NEXT_NOT_FOUND");

    expect(mocks.getWorkspacePayrollRecoveryQueue).not.toHaveBeenCalled();
  });
});
