import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWorkspacePageContext: vi.fn(),
  getWorkspaceReserve: vi.fn(),
  getWorkspaceSubscription: vi.fn()
}));

vi.mock("@paylore/database", () => ({
  getWorkspaceReserve: mocks.getWorkspaceReserve,
  getWorkspaceSubscription: mocks.getWorkspaceSubscription
}));
vi.mock("../../../../../server/workspace-page-context", () => ({
  getWorkspacePageContext: mocks.getWorkspacePageContext
}));
vi.mock("../../../../../components/workspace/WorkspaceNavigation", () => ({
  WorkspaceNavigation: () => null,
  WorkspaceLegalFooter: () => null
}));
vi.mock("../../../../../components/workspace/ReserveActions", () => ({
  ReserveActions: () => null
}));

import WorkspaceReservePage from "./page";

describe("workspace reserve readiness copy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getWorkspacePageContext.mockResolvedValue({
      db: {},
      session: { userId: "admin-a" },
      workspace: { workspaceName: "Studio", role: "organization_admin" }
    });
    mocks.getWorkspaceReserve.mockResolvedValue({
      address: "reserve-address",
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
      updatedAt: new Date("2026-10-02T00:00:00.000Z")
    });
    mocks.getWorkspaceSubscription.mockResolvedValue({ status: "active" });
  });

  it("describes the actual on-chain readiness and settlement gates instead of saying settlement is unimplemented", async () => {
    const page = await WorkspaceReservePage({
      params: Promise.resolve({ workspaceId: "workspace-a" })
    });
    const html = renderToStaticMarkup(page);

    expect(html).toContain("Key custody alone does not create or fund an on-chain confidential reserve.");
    expect(html).toContain("Configure the reserve-owned Token-2022 account and matching Payroll Program reserve state");
    expect(html).toContain("A payroll claim is reported settled only after its confidential transfer reaches finality and the reserve debit is reconciled.");
    expect(html).not.toContain("payroll settlement remains unavailable until that flow is implemented and verified");
    expect(mocks.getWorkspaceReserve).toHaveBeenCalledWith({}, "workspace-a");
    expect(mocks.getWorkspaceSubscription).toHaveBeenCalledWith({}, "workspace-a");
  });
});
