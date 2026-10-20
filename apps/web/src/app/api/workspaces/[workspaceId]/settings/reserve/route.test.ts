import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearSessionCookie: vi.fn(),
  getDatabase: vi.fn(),
  getSessionState: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  getWorkspaceReserve: vi.fn(),
  getWorkspaceSubscription: vi.fn(),
  reconcileWorkspaceReserveAccount: vi.fn(),
  initializeWorkspaceReserve: vi.fn(),
  verifyAndRestoreWorkspaceReserve: vi.fn()
}));

vi.mock("@paylore/database", () => ({
  getWorkspaceForUser: mocks.getWorkspaceForUser,
  getWorkspaceReserve: mocks.getWorkspaceReserve,
  getWorkspaceSubscription: mocks.getWorkspaceSubscription
}));

vi.mock("../../../../../../server/session", () => ({
  clearSessionCookie: mocks.clearSessionCookie,
  getSessionState: mocks.getSessionState
}));

vi.mock("../../../../../../server/security", () => ({
  assertSameOrigin: vi.fn(),
  RequestSecurityError: class extends Error {}
}));

vi.mock("../../../../../../server/db", () => ({
  getDatabase: mocks.getDatabase
}));

vi.mock("../../../../../../server/reserve", () => ({
  initializeWorkspaceReserve: mocks.initializeWorkspaceReserve,
  verifyAndRestoreWorkspaceReserve: mocks.verifyAndRestoreWorkspaceReserve
}));
vi.mock("../../../../../../server/reserve-reconciliation", () => ({
  reconcileWorkspaceReserveAccount: mocks.reconcileWorkspaceReserveAccount
}));

import { GET, POST } from "./route";

describe("workspace reserve key custody route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDatabase.mockReturnValue({});
    mocks.getSessionState.mockResolvedValue({
      status: "authenticated",
      session: { userId: "user-a" }
    });
    mocks.getWorkspaceForUser.mockResolvedValue({
      role: "organization_admin"
    });
    mocks.getWorkspaceSubscription.mockResolvedValue({
      status: "active"
    });
    mocks.getWorkspaceReserve.mockResolvedValue({
      address: "reserve-address",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z")
    });
    mocks.reconcileWorkspaceReserveAccount.mockResolvedValue({
      status: "account_missing",
      tokenAccount: "reserve-token-account"
    });
    mocks.initializeWorkspaceReserve.mockResolvedValue({
      address: "reserve-address",
      created: true
    });
  });

  it("returns custody metadata alongside finalized on-chain ATA reconciliation", async () => {
    const response = await GET(
      new Request("https://paylore.test/api/reserve"),
      { params: Promise.resolve({ workspaceId: "workspace-a" }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      reserve: { address: "reserve-address" },
      onChainAccount: {
        status: "account_missing",
        tokenAccount: "reserve-token-account"
      }
    });
    expect(mocks.reconcileWorkspaceReserveAccount)
      .toHaveBeenCalledWith("reserve-address");
  });

  it("reports key custody configured without claiming on-chain reserve readiness", async () => {
    const response = await POST(
      new Request("https://paylore.test/api/reserve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "initialize" })
      }),
      { params: Promise.resolve({ workspaceId: "workspace-a" }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "key_custody_configured",
      address: "reserve-address",
      created: true,
      restoredAt: null
    });
  });
});
