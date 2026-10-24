import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertSameOrigin: vi.fn(), clearSessionCookie: vi.fn(), getDatabase: vi.fn(),
  getSessionState: vi.fn(), getWorkspaceForUser: vi.fn(), getWorkspaceSubscription: vi.fn(),
  insertWorkspaceContributors: vi.fn(), listWorkspaceContributors: vi.fn(), isValidSolanaAddress: vi.fn()
}));
vi.mock("@paylore/database", () => ({
  getWorkspaceForUser: mocks.getWorkspaceForUser, getWorkspaceSubscription: mocks.getWorkspaceSubscription,
  insertWorkspaceContributors: mocks.insertWorkspaceContributors, listWorkspaceContributors: mocks.listWorkspaceContributors
}));
vi.mock("../../../../../server/session", () => ({ clearSessionCookie: mocks.clearSessionCookie, getSessionState: mocks.getSessionState }));
vi.mock("../../../../../server/security", () => ({
  assertSameOrigin: mocks.assertSameOrigin, isValidSolanaAddress: mocks.isValidSolanaAddress,
  RequestSecurityError: class RequestSecurityError extends Error {}
}));
vi.mock("../../../../../server/db", () => ({ getDatabase: mocks.getDatabase }));
import { GET, POST } from "./route";

const context = { params: Promise.resolve({ workspaceId: "workspace-a" }) };
const wallet = "11111111111111111111111111111111";
const contributor = {
  id: "contributor-a", displayName: "Ada", identityWalletAddress: wallet, effectivePayoutAddress: wallet,
  organizationLabel: "Research", adminNote: "internal compensation follow-up", role: "finance_auditor",
  lifecycle: "invited", onboardingStatus: "pending"
};
function request(method: string, body?: unknown) {
  return new Request("https://paylore.test/api/contributors", {
    method, headers: { origin: "https://paylore.test", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}
describe("workspace contributor directory API", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.assertSameOrigin.mockImplementation(() => undefined);
    mocks.getDatabase.mockReturnValue({});
    mocks.getSessionState.mockResolvedValue({ status: "authenticated", session: { userId: "admin-user", walletAddress: "admin-wallet" } });
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "organization_admin" });
    mocks.getWorkspaceSubscription.mockResolvedValue({ status: "active" });
    mocks.isValidSolanaAddress.mockReturnValue(true);
    mocks.listWorkspaceContributors.mockResolvedValue([contributor]);
    mocks.insertWorkspaceContributors.mockResolvedValue([contributor]);
  });
  it("does not expose local administrator notes or labels to Finance/Auditor reads", async () => {
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "finance_auditor" });
    const response = await GET(request("GET"), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.contributors[0]).toMatchObject({ displayName: "Ada", role: "finance_auditor" });
    expect(body.contributors[0]).not.toHaveProperty("adminNote");
    expect(body.contributors[0]).not.toHaveProperty("organizationLabel");
  });
  it("allows an admin to assign Finance/Auditor but prevents Organization Administrator elevation", async () => {
    mocks.listWorkspaceContributors.mockResolvedValue([]);
    const response = await POST(request("POST", { contributors: [{
      displayName: "Ada", identityWalletAddress: wallet, effectivePayoutAddress: wallet, role: "finance_auditor",
      organizationLabel: "Finance", adminNote: "Read-only review"
    }]}), context);
    expect(response.status).toBe(201);
    expect(mocks.insertWorkspaceContributors).toHaveBeenCalledWith({}, "workspace-a", [
      expect.objectContaining({ role: "finance_auditor", organizationLabel: "Finance", adminNote: "Read-only review" })
    ]);
    const elevated = await POST(request("POST", { contributors: [{
      displayName: "Eve", identityWalletAddress: wallet, effectivePayoutAddress: wallet, role: "organization_admin"
    }]}), context);
    expect(elevated.status).toBe(400);
    expect(mocks.insertWorkspaceContributors).toHaveBeenCalledTimes(1);
  });
  it("requires an active subscription and rejects duplicate workspace wallets", async () => {
    mocks.listWorkspaceContributors.mockResolvedValue([contributor]);
    const duplicate = await POST(request("POST", { contributors: [{
      displayName: "Ada duplicate", identityWalletAddress: wallet, effectivePayoutAddress: wallet
    }]}), context);
    expect(duplicate.status).toBe(409);
    mocks.listWorkspaceContributors.mockResolvedValue([]);
    mocks.getWorkspaceSubscription.mockResolvedValue({ status: "expired" });
    const archived = await POST(request("POST", { contributors: [{
      displayName: "Grace", identityWalletAddress: "22222222222222222222222222222222",
      effectivePayoutAddress: "22222222222222222222222222222222"
    }]}), context);
    expect(archived.status).toBe(409);
    expect(mocks.insertWorkspaceContributors).not.toHaveBeenCalled();
  });
});
