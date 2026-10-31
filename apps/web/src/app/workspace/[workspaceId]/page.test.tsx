import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  getSessionState: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  getWorkspaceSubscription: vi.fn(),
  listWorkspaceMemberships: vi.fn(),
  getWorkspaceSetupProgress: vi.fn()
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: any; [key: string]: any }) =>
    <a href={href} {...props}>{children}</a>
}));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); },
  redirect: (target: string) => { throw new Error("NEXT_REDIRECT:" + target); }
}));
vi.mock("@paylore/database", () => ({
  getWorkspaceForUser: mocks.getWorkspaceForUser,
  getWorkspaceSubscription: mocks.getWorkspaceSubscription,
  listWorkspaceMemberships: mocks.listWorkspaceMemberships
}));
vi.mock("../../../server/db", () => ({
  getDatabase: mocks.getDatabase
}));
vi.mock("../../../server/session", () => ({
  getSessionState: mocks.getSessionState
}));
vi.mock("../../../server/config", () => ({
  loadPayloreConfig: () => ({
    PAYLORE_SUBSCRIPTION_RECIPIENT: "recipient",
    PAYLORE_SUBSCRIPTION_USDC_MINT: "mint"
  })
}));
vi.mock("../../../server/security", () => ({
  isValidSolanaAddress: () => true
}));
vi.mock("../../../server/workspace-setup-progress", () => ({
  getWorkspaceSetupProgress: mocks.getWorkspaceSetupProgress
}));
vi.mock("../../../components/auth/SignOutButton", () => ({
  SignOutButton: () => null
}));
vi.mock("../../../components/workspace/WorkspaceActivation", () => ({
  WorkspaceActivation: () => <div>Activation screen</div>
}));
vi.mock("../../../components/workspace/WorkspaceNavigation", () => ({
  WorkspaceNavigation: () => null,
  WorkspaceLegalFooter: () => null
}));

import WorkspacePage from "./page";

const db = { tag: "test-db" };
const adminSession = {
  status: "authenticated",
  session: { userId: "admin-a", walletAddress: "wallet-a" }
};
const workspace = {
  workspaceId: "workspace-a",
  workspaceName: "Studio",
  role: "organization_admin"
};
const incompleteProgress = {
  gasTank: {
    status: "funding_required",
    address: "gas-tank-address",
    balanceSol: "0.001"
  },
  reserve: { status: "setup_required" },
  complete: false
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getDatabase.mockReturnValue(db);
  mocks.getSessionState.mockResolvedValue(adminSession);
  mocks.getWorkspaceForUser.mockResolvedValue(workspace);
  mocks.listWorkspaceMemberships.mockResolvedValue([{
    workspaceId: "workspace-a", workspaceName: "Studio", role: "organization_admin"
  }]);
  mocks.getWorkspaceSubscription.mockResolvedValue({
    status: "active", periodEnd: null, cancelAtPeriodEnd: false
  });
  mocks.getWorkspaceSetupProgress.mockResolvedValue(incompleteProgress);
});

describe("active workspace setup checklist", () => {
  it("persists on the workspace home and puts Gas Tank funding before confidential Reserve setup", async () => {
    const page = await WorkspacePage({
      params: Promise.resolve({ workspaceId: "workspace-a" }),
      searchParams: Promise.resolve({})
    });
    const html = renderToStaticMarkup(page);

    expect(html).toContain("Workspace setup is incomplete");
    expect(html).toContain("Gas Tank setup");
    expect(html).toContain("Transfer SOL from the administrator wallet");
    expect(html).toContain("Confidential reserve setup");
    expect(html.indexOf("Gas Tank setup")).toBeLessThan(html.indexOf("Confidential reserve setup"));
    expect(html).toContain('href="/workspace/workspace-a/gas-tank"');
    expect(html).toContain('href="/workspace/workspace-a/settings/reserve"');
    expect(mocks.getWorkspaceSetupProgress).toHaveBeenCalledWith(
      db, "workspace-a", "wallet-a"
    );
  });

  it("does not describe an activated subscription as fully ready while Reserve setup is incomplete", async () => {
    const page = await WorkspacePage({
      params: Promise.resolve({ workspaceId: "workspace-a" }),
      searchParams: Promise.resolve({ activated: "1" })
    });
    const html = renderToStaticMarkup(page);

    expect(html).toContain("Studio subscription is active.");
    expect(html).toContain("Finish Gas Tank funding and confidential Reserve setup below");
    expect(html).toContain("Workspace setup is incomplete");
    expect(html).not.toContain("Studio is active and ready to use.");
  });

  it("hides setup tasks once the live checks report completion", async () => {
    mocks.getWorkspaceSetupProgress.mockResolvedValue({
      gasTank: { status: "ready", address: "gas-tank-address", balanceSol: "0.2" },
      reserve: { status: "ready" },
      complete: true
    });
    const page = await WorkspacePage({
      params: Promise.resolve({ workspaceId: "workspace-a" }),
      searchParams: Promise.resolve({})
    });
    const html = renderToStaticMarkup(page);

    expect(html).not.toContain("Workspace setup is incomplete");
    expect(html).not.toContain("Finish setting up this workspace");
  });

  it("gives Finance/Auditor a read-only dashboard to the workspace records", async () => {
    mocks.getWorkspaceForUser.mockResolvedValue({
      ...workspace,
      role: "finance_auditor"
    });
    const page = await WorkspacePage({
      params: Promise.resolve({ workspaceId: "workspace-a" }),
      searchParams: Promise.resolve({})
    });
    const html = renderToStaticMarkup(page);

    expect(html).toContain("Finance &amp; audit");
    expect(html).toContain("Workspace records");
    expect(html).toContain("Your Finance/Auditor access is read-only.");
    expect(html).toContain('href="/workspace/workspace-a/payroll"');
    expect(html).toContain('href="/workspace/workspace-a/contributors"');
    expect(html).toContain('href="/workspace/workspace-a/ledger"');
    expect(html).toContain('href="/workspace/workspace-a/billing"');
    expect(html).not.toContain('href="/workspace/workspace-a/recovery"');
    expect(html).not.toContain('href="/workspace/workspace-a/settings/reserve"');
    expect(html).not.toContain('href="/workspace/workspace-a/contributors/invitations"');
    expect(mocks.getWorkspaceSetupProgress).not.toHaveBeenCalled();
  });

  it("gives contributors a direct compensation destination without administrator controls", async () => {
    mocks.getWorkspaceForUser.mockResolvedValue({
      ...workspace,
      role: "contributor"
    });
    const page = await WorkspacePage({
      params: Promise.resolve({ workspaceId: "workspace-a" }),
      searchParams: Promise.resolve({})
    });
    const html = renderToStaticMarkup(page);

    expect(html).toContain("Your payroll");
    expect(html).toContain('href="/workspace/workspace-a/compensation"');
    expect(html).not.toContain("Workspace tools");
    expect(html).not.toContain("Confidential reserve setup");
    expect(mocks.getWorkspaceSetupProgress).not.toHaveBeenCalled();
  });

  it("does not show administrator setup steps or call setup reconciliation for the auditor role", async () => {
    mocks.getWorkspaceForUser.mockResolvedValue({
      ...workspace,
      role: "finance_auditor"
    });
    const page = await WorkspacePage({
      params: Promise.resolve({ workspaceId: "workspace-a" }),
      searchParams: Promise.resolve({})
    });
    const html = renderToStaticMarkup(page);

    expect(html).not.toContain("Workspace setup is incomplete");
    expect(html).not.toContain("Confidential reserve setup");
    expect(mocks.getWorkspaceSetupProgress).not.toHaveBeenCalled();
  });

  it("does not render setup steps for a workspace with an inactive subscription", async () => {
    mocks.getWorkspaceSubscription.mockResolvedValue({ status: "inactive" });
    const page = await WorkspacePage({
      params: Promise.resolve({ workspaceId: "workspace-a" }),
      searchParams: Promise.resolve({})
    });
    const html = renderToStaticMarkup(page);

    expect(html).toContain("Activation screen");
    expect(html).not.toContain("Gas Tank setup");
    expect(mocks.getWorkspaceSetupProgress).not.toHaveBeenCalled();
  });
});
