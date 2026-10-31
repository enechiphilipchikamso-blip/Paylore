import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearSessionCookie: vi.fn(),
  getDatabase: vi.fn(),
  getSessionState: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  getWorkspaceReserve: vi.fn(),
  getWorkspaceSubscription: vi.fn(),
  initializeWorkspaceReserve: vi.fn(),
  verifyAndRestoreWorkspaceReserve: vi.fn(),
  getWorkspaceConfidentialReserveSnapshot: vi.fn(),
  initializeWorkspaceConfidentialReserveAccount: vi.fn(),
  MockWorkspaceReserveInitializationError: class extends Error {
    constructor(readonly code: string, readonly statusCode: number) {
      super(code);
    }
  }
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

vi.mock("../../../../../../server/solana/workspace-reserve", () => ({
  getWorkspaceConfidentialReserveSnapshot: mocks.getWorkspaceConfidentialReserveSnapshot,
  initializeWorkspaceConfidentialReserveAccount: mocks.initializeWorkspaceConfidentialReserveAccount,
  WorkspaceReserveInitializationError: mocks.MockWorkspaceReserveInitializationError
}));

import { GET, POST } from "./route";

const routeContext = { params: Promise.resolve({ workspaceId: "workspace-a" }) };

function request(body: unknown) {
  return new Request("https://paylore.test/api/reserve", {
    method: "POST",
    headers: {
      origin: "https://paylore.test",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

describe("workspace reserve key custody and on-chain setup route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDatabase.mockReturnValue({});
    mocks.getSessionState.mockResolvedValue({
      status: "authenticated",
      session: { userId: "user-a", walletAddress: "wallet-a" }
    });
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "organization_admin" });
    mocks.getWorkspaceSubscription.mockResolvedValue({ status: "active" });
    mocks.getWorkspaceReserve.mockResolvedValue({
      address: "reserve-address",
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z")
    });
    mocks.getWorkspaceConfidentialReserveSnapshot.mockResolvedValue({
      status: "account_missing",
      reserveAddress: "reserve-address",
      tokenAccount: "reserve-token-account",
      confidentialTransferReady: false
    });
    mocks.initializeWorkspaceReserve.mockResolvedValue({
      address: "reserve-address",
      created: true
    });
    mocks.verifyAndRestoreWorkspaceReserve.mockResolvedValue({
      address: "reserve-address",
      restoredAt: new Date("2026-01-03T00:00:00.000Z")
    });
    mocks.initializeWorkspaceConfidentialReserveAccount.mockResolvedValue({
      status: "program_configured",
      reserveAddress: "reserve-address",
      tokenAccount: "reserve-token-account",
      confidentialTransferReady: true,
      programReserveConfigured: true
    });
  });

  it("returns encrypted-custody metadata and the independent finalized on-chain state", async () => {
    const response = await GET(new Request("https://paylore.test/api/reserve"), {
      params: routeContext.params
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      reserve: { address: "reserve-address" },
      onChainAccount: {
        status: "account_missing",
        tokenAccount: "reserve-token-account",
        confidentialTransferReady: false
      }
    });
    expect(mocks.getWorkspaceConfidentialReserveSnapshot).toHaveBeenCalledWith(
      {}, "workspace-a", "wallet-a"
    );
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("reports key custody configured without claiming on-chain reserve readiness", async () => {
    const response = await POST(request({ action: "initialize" }), {
      params: routeContext.params
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "key_custody_configured",
      address: "reserve-address",
      created: true,
      restoredAt: null
    });
    expect(mocks.initializeWorkspaceReserve).toHaveBeenCalledWith({}, "workspace-a");
    expect(mocks.initializeWorkspaceConfidentialReserveAccount).not.toHaveBeenCalled();
  });

  it("verifies reserve key backup and returns honest custody-only status", async () => {
    const response = await POST(request({ action: "restore" }), {
      params: routeContext.params
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "key_custody_configured",
      address: "reserve-address",
      created: false,
      restoredAt: "2026-01-03T00:00:00.000Z"
    });
    expect(mocks.verifyAndRestoreWorkspaceReserve).toHaveBeenCalledWith({}, "workspace-a");
    expect(mocks.initializeWorkspaceConfidentialReserveAccount).not.toHaveBeenCalled();
  });

  it("exposes finalized confidential-account initialization as a separate operation", async () => {
    const response = await POST(request({ action: "initialize_confidential" }), {
      params: routeContext.params
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "program_configured",
      confidentialTransferReady: true,
      programReserveConfigured: true
    });
    expect(mocks.initializeWorkspaceConfidentialReserveAccount).toHaveBeenCalledWith(
      {}, "workspace-a", "wallet-a", { signature: null, phase: null }
    );
    expect(mocks.initializeWorkspaceReserve).not.toHaveBeenCalled();
  });

  it("preserves pending finality as a 202 rather than declaring reserve readiness", async () => {
    mocks.initializeWorkspaceConfidentialReserveAccount.mockResolvedValue({
      status: "pending",
      signature: "reserve-setup-signature",
      phase: "account_setup",
      confidentialTransferReady: false,
      programReserveConfigured: false
    });

    const response = await POST(request({
      action: "initialize_confidential",
      signature: "p".repeat(64),
      phase: "account_setup"
    }), { params: routeContext.params });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: "pending",
      signature: "reserve-setup-signature",
      programReserveConfigured: false
    });
  });

  it("does not attempt writes for a read-only subscription", async () => {
    mocks.getWorkspaceSubscription.mockResolvedValue({ status: "archived" });
    const response = await POST(request({ action: "initialize_confidential" }), {
      params: routeContext.params
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "workspace_read_only" });
    expect(mocks.initializeWorkspaceConfidentialReserveAccount).not.toHaveBeenCalled();
  });

  it("keeps initialization errors stable and secret-safe", async () => {
    mocks.initializeWorkspaceConfidentialReserveAccount.mockRejectedValue(
      new mocks.MockWorkspaceReserveInitializationError("reserve_program_state_mismatch", 409)
    );
    const response = await POST(request({ action: "initialize_confidential" }), {
      params: routeContext.params
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({
      error: "reserve_program_state_mismatch",
      retryable: false
    });
  });

  it("logs Gas Tank reserve initialization failures with the correct event and safe code", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.initializeWorkspaceConfidentialReserveAccount.mockRejectedValue(
      new mocks.MockWorkspaceReserveInitializationError("reserve_gas_tank_insufficient_funds", 409)
    );

    try {
      const response = await POST(request({ action: "initialize_confidential" }), {
        params: routeContext.params
      });
      expect(response.status).toBe(409);
      await expect(response.json()).resolves.toEqual({
        error: "reserve_gas_tank_insufficient_funds",
        retryable: false
      });
      expect(log).toHaveBeenCalledWith(JSON.stringify({
        event: "workspace_confidential_reserve_initialization_failed",
        code: "reserve_gas_tank_insufficient_funds",
        status: 409
      }));
    } finally {
      log.mockRestore();
    }
  });

  it("uses a route-level error when setup fails before the requested action is known", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.getWorkspaceForUser.mockRejectedValue(new Error("database internals"));
    try {
      const response = await POST(request({ action: "initialize_confidential" }), {
        params: routeContext.params
      });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "reserve_operation_unavailable",
        retryable: true
      });
      expect(log).toHaveBeenCalledWith(JSON.stringify({
        event: "workspace_reserve_route_failed",
        code: "unexpected_operation_failure"
      }));
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining("database internals"));
    } finally {
      log.mockRestore();
    }
  });

  it("uses an operation-specific error when an unexpected Reserve setup failure occurs", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.initializeWorkspaceConfidentialReserveAccount.mockRejectedValue(new Error("provider internals"));
    try {
      const response = await POST(request({ action: "initialize_confidential" }), {
        params: routeContext.params
      });
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toEqual({
        error: "reserve_operation_unavailable",
        retryable: true
      });
      expect(log).toHaveBeenCalledWith(JSON.stringify({
        event: "workspace_confidential_reserve_initialization_failed",
        code: "unexpected_operation_failure"
      }));
      expect(log).not.toHaveBeenCalledWith(expect.stringContaining("provider internals"));
    } finally {
      log.mockRestore();
    }
  });
});
