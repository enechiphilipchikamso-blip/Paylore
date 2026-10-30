import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listWorkspaceContributors: vi.fn(),
  getWorkspacePageContext: vi.fn(),
  directoryProps: null as Record<string, unknown> | null
}));

vi.mock("@paylore/database", () => ({
  listWorkspaceContributors: mocks.listWorkspaceContributors
}));
vi.mock("../../../../server/workspace-page-context", () => ({
  getWorkspacePageContext: mocks.getWorkspacePageContext
}));
vi.mock("../../../../components/workspace/ContributorDirectory", () => ({
  ContributorDirectory: (props: Record<string, unknown>) => {
    mocks.directoryProps = props;
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

import ContributorsPage from "./page";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.directoryProps = null;
  mocks.getWorkspacePageContext.mockResolvedValue({
    db: { tag: "test-db" },
    workspace: {
      workspaceId: "workspace-a",
      workspaceName: "Studio",
      role: "finance_auditor"
    }
  });
  mocks.listWorkspaceContributors.mockResolvedValue([{
    id: "contributor-a",
    displayName: "Alex",
    identityWalletAddress: "wallet-a",
    effectivePayoutAddress: "wallet-a",
    organizationLabel: "Design",
    adminNote: "Private administrator note",
    lifecycle: "active",
    onboardingStatus: "active",
    role: "contributor"
  }]);
});

describe("contributor directory role experience", () => {
  it("keeps Finance/Auditor contributor records read-only and redacts administrator-only fields", async () => {
    const page = await ContributorsPage({
      params: Promise.resolve({ workspaceId: "workspace-a" })
    });
    const html = renderToStaticMarkup(page);

    expect(html).toContain("This Finance/Auditor view is read-only.");
    expect(mocks.directoryProps).toMatchObject({
      workspaceId: "workspace-a",
      canManage: false,
      records: [{
        id: "contributor-a",
        organizationLabel: null,
        adminNote: null
      }]
    });
  });

  it("preserves administrator profile management", async () => {
    mocks.getWorkspacePageContext.mockResolvedValue({
      db: { tag: "test-db" },
      workspace: {
        workspaceId: "workspace-a",
        workspaceName: "Studio",
        role: "organization_admin"
      }
    });

    const page = await ContributorsPage({
      params: Promise.resolve({ workspaceId: "workspace-a" })
    });
    renderToStaticMarkup(page);

    expect(mocks.directoryProps).toMatchObject({
      canManage: true,
      records: [{
        organizationLabel: "Design",
        adminNote: "Private administrator note"
      }]
    });
  });

  it("preserves contributor denial", async () => {
    mocks.getWorkspacePageContext.mockResolvedValue({
      db: { tag: "test-db" },
      workspace: {
        workspaceId: "workspace-a",
        workspaceName: "Studio",
        role: "contributor"
      }
    });

    await expect(ContributorsPage({
      params: Promise.resolve({ workspaceId: "workspace-a" })
    })).rejects.toThrow("NEXT_NOT_FOUND");
    expect(mocks.listWorkspaceContributors).not.toHaveBeenCalled();
  });
});
