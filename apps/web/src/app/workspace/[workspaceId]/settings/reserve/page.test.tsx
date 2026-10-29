import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWorkspacePageContext: vi.fn(),
  getWorkspaceReserve: vi.fn(),
  getWorkspaceSubscription: vi.fn(),
  getWorkspaceGasTankSnapshot: vi.fn(),
  reserveActionProps: null as Record<string, unknown> | null
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
  ReserveActions: (props: Record<string, unknown>) => {
    mocks.reserveActionProps = props;
    return null;
  }
}));
vi.mock("../../../../../server/gas-tank", () => ({
  getWorkspaceGasTankSnapshot: mocks.getWorkspaceGasTankSnapshot
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
    mocks.getWorkspaceGasTankSnapshot.mockResolvedValue({
      address: "gas-tank-address",
      balanceLamports: "200000000",
      lowBalance: false
    });
  });

  it("marks Gas Tank setup as required when no workspace Gas Tank exists", async () => {
    mocks.getWorkspaceGasTankSnapshot.mockResolvedValue(null);
    const page = await WorkspaceReservePage({
      params: Promise.resolve({ workspaceId: "workspace-a" })
    });
    renderToStaticMarkup(page);

    expect(mocks.reserveActionProps).toMatchObject({
      gasTankPreflight: {
        status: "not_initialized",
        address: null,
        balanceSol: null
      }
    });
  });

  it("fails closed when the live Gas Tank balance is unavailable", async () => {
    mocks.getWorkspaceGasTankSnapshot.mockRejectedValue(new Error("RPC unavailable"));
    const page = await WorkspaceReservePage({
      params: Promise.resolve({ workspaceId: "workspace-a" })
    });
    renderToStaticMarkup(page);

    expect(mocks.reserveActionProps).toMatchObject({
      gasTankPreflight: {
        status: "unavailable",
        address: null,
        balanceSol: null
      }
    });
  });

  it("describes the actual on-chain readiness and settlement gates instead of saying settlement is unimplemented", async () => {
    const page = await WorkspaceReservePage({
      params: Promise.resolve({ workspaceId: "workspace-a" })
    });
    const html = renderToStaticMarkup(page);

    expect(html).toContain("Key custody alone does not create or fund an on-chain confidential reserve.");
    expect(html).toContain("Initialize the workspace Gas Tank and fund it with SOL first");
    expect(html).toContain("the Gas Tank pays Reserve setup transaction fees and account rent");
    expect(html).toContain("Configure the reserve-owned Token-2022 account and matching Payroll Program reserve state");
    expect(html).toContain("A payroll claim is reported settled only after its confidential transfer reaches finality and the reserve debit is reconciled.");
    expect(html).not.toContain("payroll settlement remains unavailable until that flow is implemented and verified");
    expect(mocks.getWorkspaceReserve).toHaveBeenCalledWith({}, "workspace-a");
    expect(mocks.getWorkspaceSubscription).toHaveBeenCalledWith({}, "workspace-a");
    expect(mocks.getWorkspaceGasTankSnapshot).toHaveBeenCalledWith({}, "workspace-a");
    expect(mocks.reserveActionProps).toMatchObject({
      workspaceId: "workspace-a",
      gasTankPreflight: {
        status: "ready",
        address: "gas-tank-address",
        balanceSol: "0.2"
      }
    });
  });
});
