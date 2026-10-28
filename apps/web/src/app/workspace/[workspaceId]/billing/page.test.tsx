import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getDatabase: vi.fn(),
  getSessionState: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  getWorkspaceSubscription: vi.fn(),
  listSubscriptionPayments: vi.fn(),
  loadPayloreConfig: vi.fn(),
  isValidSolanaAddress: vi.fn(),
  notFound: vi.fn(),
  redirect: vi.fn(),
  BillingActions: vi.fn(() => null)
}));

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound,
  redirect: mocks.redirect
}));
vi.mock("@paylore/database", () => ({
  getWorkspaceForUser: mocks.getWorkspaceForUser,
  getWorkspaceSubscription: mocks.getWorkspaceSubscription,
  listSubscriptionPayments: mocks.listSubscriptionPayments
}));
vi.mock("../../../../server/db", () => ({
  getDatabase: mocks.getDatabase
}));
vi.mock("../../../../server/session", () => ({
  getSessionState: mocks.getSessionState
}));
vi.mock("../../../../server/config", () => ({
  loadPayloreConfig: mocks.loadPayloreConfig
}));
vi.mock("../../../../server/security", () => ({
  isValidSolanaAddress: mocks.isValidSolanaAddress
}));
vi.mock("../../../../components/workspace/BillingActions", () => ({
  BillingActions: mocks.BillingActions
}));
vi.mock("../../../../components/workspace/WorkspaceNavigation", () => ({
  WorkspaceNavigation: () => null,
  WorkspaceLegalFooter: () => null
}));

import { BillingActions } from "../../../../components/workspace/BillingActions";
import WorkspaceBillingPage from "./page";

const context = { params: Promise.resolve({ workspaceId: "workspace-a" }) };

function setRole(role: "organization_admin" | "finance_auditor" | "contributor") {
  mocks.getWorkspaceForUser.mockResolvedValue({
    role,
    workspaceName: "Research"
  });
}

function findElement(
  node: unknown,
  type: unknown
): { props?: Record<string, unknown> } | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElement(child, type);
      if (found) return found;
    }
    return null;
  }
  if (!node || typeof node !== "object") return null;
  const element = node as {
    type?: unknown;
    props?: { children?: unknown; [key: string]: unknown };
  };
  if (element.type === type) return element;
  return findElement(element.props?.children, type);
}

describe("workspace billing page role/read matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDatabase.mockReturnValue({});
    mocks.getSessionState.mockResolvedValue({
      status: "authenticated",
      session: { userId: "user-a", walletAddress: "wallet-a" }
    });
    setRole("organization_admin");
    mocks.getWorkspaceSubscription.mockResolvedValue({
      status: "archived",
      periodStart: new Date("2026-10-01T00:00:00.000Z"),
      periodEnd: new Date("2026-10-31T00:00:00.000Z"),
      cancelAtPeriodEnd: false
    });
    mocks.listSubscriptionPayments.mockResolvedValue([]);
    mocks.loadPayloreConfig.mockReturnValue({
      PAYLORE_SUBSCRIPTION_RECIPIENT: "recipient",
      PAYLORE_SUBSCRIPTION_USDC_MINT: "mint"
    });
    mocks.isValidSolanaAddress.mockReturnValue(true);
    mocks.notFound.mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");
    });
    mocks.redirect.mockImplementation((destination: string) => {
      throw new Error(`NEXT_REDIRECT:${destination}`);
    });
  });

  it("allows administrators to read billing and retains management capability", async () => {
    setRole("organization_admin");
    const page = await WorkspaceBillingPage(context);
    expect(page).not.toBeNull();
    expect(mocks.getWorkspaceSubscription).toHaveBeenCalledWith({}, "workspace-a");
    expect(mocks.listSubscriptionPayments).toHaveBeenCalledWith({}, "workspace-a");
    expect(findElement(page, BillingActions)?.props?.canManage).toBe(true);
  });

  it("preserves Finance/Auditor billing history access without management capability", async () => {
    setRole("finance_auditor");
    const page = await WorkspaceBillingPage(context);
    expect(page).not.toBeNull();
    expect(mocks.getWorkspaceSubscription).toHaveBeenCalledWith({}, "workspace-a");
    expect(mocks.listSubscriptionPayments).toHaveBeenCalledWith({}, "workspace-a");
    expect(findElement(page, BillingActions)?.props?.canManage).toBe(false);
  });

  it("does not load or render organization billing history for a contributor", async () => {
    setRole("contributor");
    await expect(WorkspaceBillingPage(context)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.notFound).toHaveBeenCalledTimes(1);
    expect(mocks.getWorkspaceSubscription).not.toHaveBeenCalled();
    expect(mocks.listSubscriptionPayments).not.toHaveBeenCalled();
  });

  it("requires an authenticated workspace member", async () => {
    mocks.getSessionState.mockResolvedValue({ status: "unauthenticated" });
    await expect(WorkspaceBillingPage(context)).rejects.toThrow("NEXT_REDIRECT:");
    expect(mocks.getWorkspaceForUser).not.toHaveBeenCalled();

    mocks.getSessionState.mockResolvedValue({
      status: "authenticated",
      session: { userId: "user-a", walletAddress: "wallet-a" }
    });
    mocks.getWorkspaceForUser.mockResolvedValue(null);
    await expect(WorkspaceBillingPage(context)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.getWorkspaceSubscription).not.toHaveBeenCalled();
  });
});
