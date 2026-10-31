import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWorkspacePageContext: vi.fn()
}));

vi.mock("next/link", () => ({
  default: ({ href, children, ...props }: { href: string; children: any; [key: string]: any }) =>
    <a href={href} {...props}>{children}</a>
}));
vi.mock("next/navigation", () => ({
  notFound: () => { throw new Error("NEXT_NOT_FOUND"); }
}));
vi.mock("../../../../server/workspace-page-context", () => ({
  getWorkspacePageContext: mocks.getWorkspacePageContext
}));
vi.mock("../../../../components/workspace/WorkspaceNavigation", () => ({
  WorkspaceNavigation: () => null,
  WorkspaceLegalFooter: () => null
}));

import WorkspaceSettingsPage from "./page";

beforeEach(() => {
  mocks.getWorkspacePageContext.mockResolvedValue({
    workspace: {
      workspaceName: "Studio",
      role: "organization_admin"
    }
  });
});

describe("workspace settings role presentation", () => {
  it("shows administrator controls without changing their server-owned role gate", async () => {
    const page = await WorkspaceSettingsPage({
      params: Promise.resolve({ workspaceId: "workspace-a" })
    });
    const html = renderToStaticMarkup(page);

    expect(html).not.toContain("<main");
    expect(html).toContain("Manage billing");
    expect(html).toContain("Manage confidential reserve");
    expect(html).toContain("Review data retention");
  });

  it("keeps Finance/Auditor settings read-only and hides administrator controls", async () => {
    mocks.getWorkspacePageContext.mockResolvedValue({
      workspace: {
        workspaceName: "Studio",
        role: "finance_auditor"
      }
    });
    const page = await WorkspaceSettingsPage({
      params: Promise.resolve({ workspaceId: "workspace-a" })
    });
    const html = renderToStaticMarkup(page);

    expect(html).toContain("View billing");
    expect(html).not.toContain("Manage billing");
    expect(html).not.toContain("Manage confidential reserve");
    expect(html).not.toContain("Review data retention");
    expect(html).toContain("Security overview");
  });

  it("preserves the existing contributor denial", async () => {
    mocks.getWorkspacePageContext.mockResolvedValue({
      workspace: {
        workspaceName: "Studio",
        role: "contributor"
      }
    });

    await expect(WorkspaceSettingsPage({
      params: Promise.resolve({ workspaceId: "workspace-a" })
    })).rejects.toThrow("NEXT_NOT_FOUND");
  });
});
