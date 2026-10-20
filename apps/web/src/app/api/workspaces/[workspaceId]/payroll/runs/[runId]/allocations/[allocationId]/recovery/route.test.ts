import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockRequestSecurityError extends Error {}

  return {
    MockRequestSecurityError,
    assertSameOrigin: vi.fn(),
    clearSessionCookie: vi.fn(),
    getDatabase: vi.fn(),
    getSessionState: vi.fn(),
    getWorkspaceForUser: vi.fn()
  };
});

vi.mock("@paylore/database", () => ({
  getWorkspaceForUser: mocks.getWorkspaceForUser
}));

vi.mock("../../../../../../../../../../server/session", () => ({
  clearSessionCookie: mocks.clearSessionCookie,
  getSessionState: mocks.getSessionState
}));

vi.mock("../../../../../../../../../../server/db", () => ({
  getDatabase: mocks.getDatabase
}));

vi.mock("../../../../../../../../../../server/security", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
  RequestSecurityError: mocks.MockRequestSecurityError
}));

import { POST } from "./route";

const routeContext = {
  params: Promise.resolve({ workspaceId: "workspace-a" })
};

describe("payroll recovery route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDatabase.mockReturnValue({});
    mocks.getSessionState.mockResolvedValue({
      status: "authenticated",
      session: {
        userId: "user-a",
        walletAddress: "wallet-a"
      }
    });
    mocks.getWorkspaceForUser.mockResolvedValue({
      role: "organization_admin"
    });
  });

  it("fails closed before accepting a recovery from a workspace administrator", async () => {
    const response = await POST(
      new Request("https://paylore.test/api/recovery", { method: "POST" }),
      routeContext
    );

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({
      error: "payroll_financial_recovery_unavailable"
    });
    expect(mocks.getWorkspaceForUser).toHaveBeenCalledOnce();
  });

  it("requires authentication before reaching recovery handling", async () => {
    mocks.getSessionState.mockResolvedValue({ status: "anonymous" });

    const response = await POST(
      new Request("https://paylore.test/api/recovery", { method: "POST" }),
      routeContext
    );

    expect(response.status).toBe(401);
    expect(mocks.clearSessionCookie).toHaveBeenCalledOnce();
    expect(mocks.getWorkspaceForUser).not.toHaveBeenCalled();
  });

  it("rejects non-admin workspace members", async () => {
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "finance_auditor" });

    const response = await POST(
      new Request("https://paylore.test/api/recovery", { method: "POST" }),
      routeContext
    );

    expect(response.status).toBe(403);
  });
});
