import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertSameOrigin: vi.fn(), clearSessionCookie: vi.fn(), createContributorInvitation: vi.fn(),
  getDatabase: vi.fn(), getSessionState: vi.fn(), getWorkspaceForUser: vi.fn(),
  getWorkspaceSubscription: vi.fn(), hashOpaqueToken: vi.fn(), listWorkspaceInvitations: vi.fn()
}));
vi.mock("@paylore/database", () => ({
  createContributorInvitation: mocks.createContributorInvitation, getWorkspaceForUser: mocks.getWorkspaceForUser,
  getWorkspaceSubscription: mocks.getWorkspaceSubscription, listWorkspaceInvitations: mocks.listWorkspaceInvitations
}));
vi.mock("../../../../../../server/session", () => ({ clearSessionCookie: mocks.clearSessionCookie, getSessionState: mocks.getSessionState }));
vi.mock("../../../../../../server/security", () => ({
  assertSameOrigin: mocks.assertSameOrigin, hashOpaqueToken: mocks.hashOpaqueToken,
  RequestSecurityError: class RequestSecurityError extends Error {}
}));
vi.mock("../../../../../../server/db", () => ({ getDatabase: mocks.getDatabase }));
import { GET, POST } from "./route";

const context = { params: Promise.resolve({ workspaceId: "workspace-a" }) };
const contributorId = "94b42b1b-f67a-4a3b-9ab1-8ea3d6257714";
function request(method: string, body?: unknown) {
  return new Request("https://paylore.test/api/contributor-invitations", {
    method, headers: { origin: "https://paylore.test", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}
describe("workspace contributor invitations", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.assertSameOrigin.mockImplementation(() => undefined);
    mocks.getDatabase.mockReturnValue({});
    mocks.getSessionState.mockResolvedValue({ status: "authenticated", session: { userId: "admin-user", walletAddress: "admin-wallet" } });
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "organization_admin" });
    mocks.getWorkspaceSubscription.mockResolvedValue({ status: "active" });
    mocks.hashOpaqueToken.mockReturnValue("opaque-token-hash");
    mocks.createContributorInvitation.mockResolvedValue({ id: "invitation-a" });
    mocks.listWorkspaceInvitations.mockResolvedValue([]);
  });
  it("stores only the invitation token hash and issues a workspace-specific link", async () => {
    const response = await POST(request("POST", { contributorId }), context);
    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body.invitePath).toMatch(/^\/invite\/[A-Za-z0-9_-]+$/);
    expect(mocks.createContributorInvitation).toHaveBeenCalledWith({}, expect.objectContaining({
      tokenHash: "opaque-token-hash", workspaceId: "workspace-a", contributorId,
      createdByUserId: "admin-user", expiresAt: expect.any(Date)
    }));
    expect(body).not.toHaveProperty("tokenHash");
  });
  it("does not disclose invitation lists or allow creation to Finance/Auditor", async () => {
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "finance_auditor" });
    const list = await GET(request("GET"), context);
    expect(list.status).toBe(403);
    expect(mocks.listWorkspaceInvitations).not.toHaveBeenCalled();
    const create = await POST(request("POST", { contributorId }), context);
    expect(create.status).toBe(403);
    expect(mocks.createContributorInvitation).not.toHaveBeenCalled();
  });
});
