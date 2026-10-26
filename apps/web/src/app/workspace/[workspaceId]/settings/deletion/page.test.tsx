import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWorkspacePageContext: vi.fn(),
  notFound: vi.fn(),
  WorkspaceDeletionActions: vi.fn(() => null)
}));

vi.mock("next/navigation", () => ({
  notFound: mocks.notFound
}));
vi.mock("../../../../../server/workspace-page-context", () => ({
  getWorkspacePageContext: mocks.getWorkspacePageContext
}));
vi.mock("../../../../../components/workspace/WorkspaceDeletionActions", () => ({
  WorkspaceDeletionActions: mocks.WorkspaceDeletionActions
}));
vi.mock("../../../../../components/workspace/WorkspaceNavigation", () => ({
  WorkspaceNavigation: () => null,
  WorkspaceLegalFooter: () => null
}));

import { WorkspaceDeletionActions } from "../../../../../components/workspace/WorkspaceDeletionActions";
import WorkspaceDeletionPage from "./page";

const context = { params: Promise.resolve({ workspaceId: "workspace-a" }) };

function setRole(role: "organization_admin" | "finance_auditor" | "contributor") {
  mocks.getWorkspacePageContext.mockResolvedValue({
    db: {},
    session: { userId: "user-a", walletAddress: "wallet-a" },
    workspace: {
      workspaceId: "workspace-a",
      workspaceName: "Research",
      role
    }
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

describe("workspace data retention page role matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.notFound.mockImplementation(() => {
      throw new Error("NEXT_NOT_FOUND");
    });
    setRole("organization_admin");
  });

  it("allows Organization Administrators to access retention controls", async () => {
    const page = await WorkspaceDeletionPage(context);
    expect(page).not.toBeNull();
    expect(mocks.getWorkspacePageContext).toHaveBeenCalledWith(
      "workspace-a",
      "/workspace/workspace-a/settings/deletion",
      { recordActivity: false }
    );
    expect(findElement(page, WorkspaceDeletionActions)?.props?.workspaceId).toBe("workspace-a");
    expect(mocks.notFound).not.toHaveBeenCalled();
  });

  for (const role of ["finance_auditor", "contributor"] as const) {
    it(`denies destructive retention controls to ${role}`, async () => {
      setRole(role);
      await expect(WorkspaceDeletionPage(context)).rejects.toThrow("NEXT_NOT_FOUND");
      expect(mocks.notFound).toHaveBeenCalledOnce();
    });
  }

  it("does not render retention controls when the workspace context denies membership", async () => {
    mocks.getWorkspacePageContext.mockRejectedValue(new Error("NEXT_NOT_FOUND"));
    await expect(WorkspaceDeletionPage(context)).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.WorkspaceDeletionActions).not.toHaveBeenCalled();
  });
});
