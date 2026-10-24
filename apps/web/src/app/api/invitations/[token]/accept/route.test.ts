import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  acceptContributorInvitation: vi.fn(),
  assertSameOrigin: vi.fn(),
  clearSessionCookie: vi.fn(),
  getDatabase: vi.fn(),
  getSessionState: vi.fn(),
  hashOpaqueToken: vi.fn()
}));

vi.mock("@paylore/database", () => ({
  acceptContributorInvitation: mocks.acceptContributorInvitation
}));
vi.mock("../../../../../server/session", () => ({
  clearSessionCookie: mocks.clearSessionCookie,
  getSessionState: mocks.getSessionState
}));
vi.mock("../../../../../server/security", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
  hashOpaqueToken: mocks.hashOpaqueToken,
  RequestSecurityError: class RequestSecurityError extends Error {}
}));
vi.mock("../../../../../server/db", () => ({ getDatabase: mocks.getDatabase }));

import { POST } from "./route";

const context = { params: Promise.resolve({ token: "single-use-invite-token" }) };

function request() {
  return new Request("https://paylore.test/api/invitations/token/accept", {
    method: "POST",
    headers: { origin: "https://paylore.test" }
  });
}

describe("workspace invitation acceptance route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.assertSameOrigin.mockImplementation(() => undefined);
    mocks.clearSessionCookie.mockResolvedValue(undefined);
    mocks.getDatabase.mockReturnValue({});
    mocks.getSessionState.mockResolvedValue({
      status: "authenticated",
      session: { userId: "wallet-user", walletAddress: "assigned-wallet" }
    });
    mocks.hashOpaqueToken.mockReturnValue("token-hash-only");
    mocks.acceptContributorInvitation.mockResolvedValue({
      workspaceId: "workspace-a",
      contributorId: "contributor-a",
      role: "finance_auditor"
    });
  });

  it("creates the workspace session only through an authenticated matching wallet", async () => {
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "accepted",
      workspaceId: "workspace-a",
      workspacePath: "/workspace/workspace-a"
    });
    expect(mocks.acceptContributorInvitation).toHaveBeenCalledWith({}, {
      tokenHash: "token-hash-only",
      userId: "wallet-user",
      walletAddress: "assigned-wallet"
    });
  });

  it("returns the distinct wrong-wallet denial without granting membership", async () => {
    mocks.acceptContributorInvitation.mockRejectedValue(
      new Error("The authenticated wallet does not match this invitation.")
    );
    const response = await POST(request(), context);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "invitation_wallet_mismatch" });
  });

  it("does not grant access for an expired, consumed, or otherwise unavailable invitation", async () => {
    mocks.acceptContributorInvitation.mockResolvedValue(null);
    const response = await POST(request(), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "invitation_unavailable" });
  });

  it("requires a signed-in session before evaluating the token", async () => {
    mocks.getSessionState.mockResolvedValue({ status: "unauthenticated" });
    const response = await POST(request(), context);
    expect(response.status).toBe(401);
    expect(mocks.clearSessionCookie).toHaveBeenCalledOnce();
    expect(mocks.acceptContributorInvitation).not.toHaveBeenCalled();
  });

  it("does not disclose internal repository errors", async () => {
    mocks.acceptContributorInvitation.mockRejectedValue(new Error("private database detail"));
    const response = await POST(request(), context);
    expect(response.status).toBe(500);
    await expect(response.json()).resolves.toEqual({ error: "invitation_could_not_be_accepted" });
  });
});
