import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  cancelWorkspaceDeletion: vi.fn(),
  clearSessionCookie: vi.fn(),
  getDatabase: vi.fn(),
  getSessionState: vi.fn(),
  getWorkspaceDeletionAudit: vi.fn(),
  getWorkspaceDeletionBlockers: vi.fn(),
  getWorkspaceDeletionState: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  getWorkspaceSubscription: vi.fn(),
  isWorkspaceRetentionEligible: vi.fn(),
  permanentlyDeleteEligibleWorkspace: vi.fn(),
  requestWorkspaceDeletion: vi.fn(),
  getWorkspaceGasTankSnapshot: vi.fn(),
  assertSameOrigin: vi.fn(),
  RequestSecurityError: class extends Error {}
}));

vi.mock("@paylore/database", () => ({
  cancelWorkspaceDeletion: mocks.cancelWorkspaceDeletion,
  getWorkspaceDeletionAudit: mocks.getWorkspaceDeletionAudit,
  getWorkspaceDeletionBlockers: mocks.getWorkspaceDeletionBlockers,
  getWorkspaceDeletionState: mocks.getWorkspaceDeletionState,
  getWorkspaceForUser: mocks.getWorkspaceForUser,
  getWorkspaceSubscription: mocks.getWorkspaceSubscription,
  isWorkspaceRetentionEligible: mocks.isWorkspaceRetentionEligible,
  permanentlyDeleteEligibleWorkspace: mocks.permanentlyDeleteEligibleWorkspace,
  requestWorkspaceDeletion: mocks.requestWorkspaceDeletion
}));
vi.mock("../../../../../server/session", () => ({
  clearSessionCookie: mocks.clearSessionCookie,
  getSessionState: mocks.getSessionState
}));
vi.mock("../../../../../server/security", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
  RequestSecurityError: mocks.RequestSecurityError
}));
vi.mock("../../../../../server/db", () => ({
  getDatabase: mocks.getDatabase
}));
vi.mock("../../../../../server/gas-tank", () => ({
  getWorkspaceGasTankSnapshot: mocks.getWorkspaceGasTankSnapshot
}));

import { GET, POST } from "./route";

const context = { params: Promise.resolve({ workspaceId: "workspace-a" }) };

function writeRequest(body: unknown) {
  return new Request("https://paylore.test/api/workspaces/workspace-a/retention", {
    method: "POST",
    headers: {
      origin: "https://paylore.test",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

function bodyFor(action: "request" | "cancel" | "finalize") {
  return action === "finalize"
    ? { action, confirmation: "DELETE WORKSPACE DATA" }
    : { action };
}

function setRole(role: "organization_admin" | "finance_auditor" | "contributor") {
  mocks.getWorkspaceForUser.mockResolvedValue({ role });
}

describe("workspace retention role/read-write matrix", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDatabase.mockReturnValue({});
    mocks.getSessionState.mockResolvedValue({
      status: "authenticated",
      session: { userId: "user-a", walletAddress: "wallet-a" }
    });
    setRole("organization_admin");
    mocks.getWorkspaceDeletionState.mockResolvedValue({
      lastActivityAt: new Date("2026-10-25T00:00:00.000Z")
    });
    mocks.getWorkspaceDeletionAudit.mockResolvedValue([]);
    mocks.getWorkspaceDeletionBlockers.mockResolvedValue({
      gasTank: "not_configured",
      reserve: false,
      outstandingPayroll: false,
      confidentialAccounts: false
    });
    mocks.getWorkspaceSubscription.mockResolvedValue({ status: "archived" });
    mocks.isWorkspaceRetentionEligible.mockReturnValue(false);
    mocks.requestWorkspaceDeletion.mockResolvedValue({
      created: true,
      scheduledAt: new Date("2026-10-28T00:00:00.000Z")
    });
    mocks.cancelWorkspaceDeletion.mockResolvedValue({ workspaceId: "workspace-a" });
    mocks.permanentlyDeleteEligibleWorkspace.mockResolvedValue({
      status: "deleted"
    });
    mocks.getWorkspaceGasTankSnapshot.mockResolvedValue(null);
    mocks.assertSameOrigin.mockImplementation(() => undefined);
  });

  const roles = [
    { role: "organization_admin" as const, readStatus: 200, writeStatus: 200 },
    { role: "finance_auditor" as const, readStatus: 403, writeStatus: 403 },
    { role: "contributor" as const, readStatus: 403, writeStatus: 403 }
  ];

  for (const entry of roles) {
    it(`restricts retention read and destructive actions for ${entry.role}`, async () => {
      setRole(entry.role);

      const read = await GET(
        new Request("https://paylore.test/api/workspaces/workspace-a/retention"),
        context
      );
      expect(read.status).toBe(entry.readStatus);
      if (entry.role === "organization_admin") {
        await expect(read.json()).resolves.toMatchObject({
          state: { lastActivityAt: "2026-10-25T00:00:00.000Z" },
          blockers: { outstandingPayroll: false }
        });
        expect(mocks.getWorkspaceGasTankSnapshot).toHaveBeenCalledOnce();
      } else {
        await expect(read.json()).resolves.toEqual({ error: "workspace_access_denied" });
        expect(mocks.getWorkspaceGasTankSnapshot).not.toHaveBeenCalled();
      }

      for (const action of ["request", "cancel", "finalize"] as const) {
        const response = await POST(writeRequest(bodyFor(action)), context);
        expect(response.status).toBe(entry.writeStatus);
      }

      if (entry.role === "organization_admin") {
        expect(mocks.requestWorkspaceDeletion).toHaveBeenCalledOnce();
        expect(mocks.cancelWorkspaceDeletion).toHaveBeenCalledOnce();
        expect(mocks.permanentlyDeleteEligibleWorkspace).toHaveBeenCalledOnce();
      } else {
        expect(mocks.requestWorkspaceDeletion).not.toHaveBeenCalled();
        expect(mocks.cancelWorkspaceDeletion).not.toHaveBeenCalled();
        expect(mocks.permanentlyDeleteEligibleWorkspace).not.toHaveBeenCalled();
      }
    });
  }

  it("requires a signed-in workspace member before allowing retention access", async () => {
    mocks.getSessionState.mockResolvedValue({ status: "unauthenticated" });
    const unauthenticated = await GET(
      new Request("https://paylore.test/api/workspaces/workspace-a/retention"),
      context
    );
    expect(unauthenticated.status).toBe(401);
    expect(mocks.clearSessionCookie).toHaveBeenCalledOnce();

    mocks.getSessionState.mockResolvedValue({
      status: "authenticated",
      session: { userId: "user-a", walletAddress: "wallet-a" }
    });
    mocks.getWorkspaceForUser.mockResolvedValue(null);
    const nonMember = await GET(
      new Request("https://paylore.test/api/workspaces/workspace-a/retention"),
      context
    );
    expect(nonMember.status).toBe(403);
    expect(mocks.getWorkspaceGasTankSnapshot).not.toHaveBeenCalled();
  });
  it("does not present workspace deletion as complete while payroll obligations remain", async () => {
    mocks.permanentlyDeleteEligibleWorkspace.mockResolvedValue({ status: "outstanding_payroll_obligations" });
    const response = await POST(writeRequest(bodyFor("finalize")), context);
    expect(response.status).toBe(423);
    await expect(response.json()).resolves.toEqual({ error: "outstanding_payroll_obligations" });
    expect(mocks.permanentlyDeleteEligibleWorkspace).toHaveBeenCalledWith({}, { workspaceId: "workspace-a" });
  });

});
