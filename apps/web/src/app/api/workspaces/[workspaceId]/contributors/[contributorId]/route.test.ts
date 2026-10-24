import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertSameOrigin: vi.fn(), clearSessionCookie: vi.fn(), getDatabase: vi.fn(),
  getSessionState: vi.fn(), getWorkspaceForUser: vi.fn(), getWorkspaceSubscription: vi.fn(),
  updateContributorAdministrativeMetadata: vi.fn()
}));
vi.mock("@paylore/database", () => ({
  getWorkspaceForUser: mocks.getWorkspaceForUser, getWorkspaceSubscription: mocks.getWorkspaceSubscription,
  updateContributorAdministrativeMetadata: mocks.updateContributorAdministrativeMetadata
}));
vi.mock("../../../../../../server/session", () => ({ clearSessionCookie: mocks.clearSessionCookie, getSessionState: mocks.getSessionState }));
vi.mock("../../../../../../server/security", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
  RequestSecurityError: class RequestSecurityError extends Error {}
}));
vi.mock("../../../../../../server/db", () => ({ getDatabase: mocks.getDatabase }));
import { PATCH } from "./route";

const context = { params: Promise.resolve({ workspaceId: "workspace-a", contributorId: "contributor-a" }) };
function request(body: unknown) {
  return new Request("https://paylore.test/api/contributors/contributor-a", {
    method: "PATCH", headers: { origin: "https://paylore.test", "content-type": "application/json" }, body: JSON.stringify(body)
  });
}
describe("workspace-local contributor profile updates", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.assertSameOrigin.mockImplementation(() => undefined);
    mocks.getDatabase.mockReturnValue({});
    mocks.getSessionState.mockResolvedValue({ status: "authenticated", session: { userId: "admin-user", walletAddress: "admin-wallet" } });
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "organization_admin" });
    mocks.getWorkspaceSubscription.mockResolvedValue({ status: "active" });
    mocks.updateContributorAdministrativeMetadata.mockResolvedValue({ id: "contributor-a", organizationLabel: "Research", adminNote: "Review quarterly" });
  });
  it("updates only workspace-scoped administrator metadata", async () => {
    const response = await PATCH(request({ organizationLabel: " Research ", adminNote: " Review quarterly " }), context);
    expect(response.status).toBe(200);
    expect(mocks.updateContributorAdministrativeMetadata).toHaveBeenCalledWith({}, {
      workspaceId: "workspace-a", contributorId: "contributor-a",
      organizationLabel: "Research", adminNote: "Review quarterly"
    });
  });
  it("rejects direct lifecycle activation so wallet verification remains authoritative", async () => {
    const response = await PATCH(request({ lifecycle: "active" }), context);
    expect(response.status).toBe(400);
    expect(mocks.updateContributorAdministrativeMetadata).not.toHaveBeenCalled();
  });
  it("denies Finance/Auditor writes and allows an administrator to clear both fields", async () => {
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "finance_auditor" });
    const denied = await PATCH(request({ adminNote: "not allowed" }), context);
    expect(denied.status).toBe(403);
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "organization_admin" });
    const cleared = await PATCH(request({ organizationLabel: "", adminNote: "" }), context);
    expect(cleared.status).toBe(200);
    expect(mocks.updateContributorAdministrativeMetadata).toHaveBeenCalledWith({}, {
      workspaceId: "workspace-a", contributorId: "contributor-a", organizationLabel: null, adminNote: null
    });
  });
});
