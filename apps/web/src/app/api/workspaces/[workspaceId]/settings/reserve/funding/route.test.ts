import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  clearSessionCookie: vi.fn(),
  getSessionState: vi.fn(),
  getDatabase: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  getWorkspaceSubscription: vi.fn(),
  getActiveWorkspaceReserveFundingOperation: vi.fn(),
  prepareReserveWrapFunding: vi.fn(),
  verifyFinalizedReserveWrapFunding: vi.fn(),
  completeWorkspaceReserveConfidentialFunding: vi.fn(),
  MockReserveWrapFundingError: class extends Error {
    constructor(readonly code: string, readonly statusCode: number) { super(code); }
  },
  MockWorkspaceReserveInitializationError: class extends Error {
    constructor(readonly code: string, readonly statusCode: number) { super(code); }
  }
}));

vi.mock("@paylore/database", () => ({
  getWorkspaceForUser: mocks.getWorkspaceForUser,
  getWorkspaceSubscription: mocks.getWorkspaceSubscription,
  getActiveWorkspaceReserveFundingOperation: mocks.getActiveWorkspaceReserveFundingOperation
}));
vi.mock("../../../../../../../server/session", () => ({
  clearSessionCookie: mocks.clearSessionCookie,
  getSessionState: mocks.getSessionState
}));
vi.mock("../../../../../../../server/security", () => ({
  assertSameOrigin: vi.fn(),
  RequestSecurityError: class extends Error {}
}));
vi.mock("../../../../../../../server/db", () => ({
  getDatabase: mocks.getDatabase
}));
vi.mock("../../../../../../../server/solana/reserve-wrap-funding", () => ({
  prepareReserveWrapFunding: mocks.prepareReserveWrapFunding,
  verifyFinalizedReserveWrapFunding: mocks.verifyFinalizedReserveWrapFunding,
  ReserveWrapFundingError: mocks.MockReserveWrapFundingError
}));
vi.mock("../../../../../../../server/solana/workspace-reserve", () => ({
  completeWorkspaceReserveConfidentialFunding: mocks.completeWorkspaceReserveConfidentialFunding,
  WorkspaceReserveInitializationError: mocks.MockWorkspaceReserveInitializationError
}));

import { GET, POST } from "./route";

const params = Promise.resolve({ workspaceId: "workspace-a" });

function request(body: unknown) {
  return new Request("https://paylore.test/api/workspaces/workspace-a/settings/reserve/funding", {
    method: "POST",
    headers: { origin: "https://paylore.test", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

function getRequest() {
  return new Request("https://paylore.test/api/workspaces/workspace-a/settings/reserve/funding", {
    method: "GET"
  });
}

describe("workspace Reserve ordinary-USDC funding route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDatabase.mockReturnValue({});
    mocks.getSessionState.mockResolvedValue({
      status: "authenticated",
      session: { userId: "user-a", walletAddress: "admin-wallet" }
    });
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "organization_admin" });
    mocks.getWorkspaceSubscription.mockResolvedValue({ status: "active" });
    mocks.getActiveWorkspaceReserveFundingOperation.mockResolvedValue(null);
    mocks.prepareReserveWrapFunding.mockResolvedValue({
      status: "prepared",
      walletAddress: "admin-wallet",
      reserveAddress: "reserve-address",
      reserveTokenAccountAddress: "reserve-token-account",
      wrappedMintAddress: "wrapped-mint",
      unwrappedMintAddress: "circle-mint",
      tokenWrapProgramAddress: "token-wrap-program",
      amountBaseUnits: "1000000"
    });
    mocks.verifyFinalizedReserveWrapFunding.mockResolvedValue({
      status: "wrapped_public_balance_verified",
      signature: "s".repeat(88),
      amountBaseUnits: "1000000",
      sourceTokenAccount: "source-account",
      escrowTokenAccount: "escrow-account",
      destinationTokenAccount: "reserve-token-account",
      slot: 123
    });
    mocks.completeWorkspaceReserveConfidentialFunding.mockResolvedValue({
      status: "confidential_balance_verified",
      wrapSignature: "s".repeat(88),
      depositSignature: "d".repeat(88),
      applySignature: "a".repeat(88),
      amountBaseUnits: "1000000",
      publicBalanceBaseUnits: "4000000",
      availableBalanceBaseUnits: "2000000"
    });
  });

  it("prepares only an authenticated administrator wallet transaction", async () => {
    const response = await POST(request({
      action: "prepare",
      amountBaseUnits: "1000000"
    }), { params });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "prepared",
      walletAddress: "admin-wallet",
      reserveTokenAccountAddress: "reserve-token-account"
    });
    expect(mocks.prepareReserveWrapFunding).toHaveBeenCalledWith({
      db: {},
      workspaceId: "workspace-a",
      walletAddress: "admin-wallet",
      amountBaseUnits: "1000000"
    });
    expect(mocks.completeWorkspaceReserveConfidentialFunding).not.toHaveBeenCalled();
  });

  it("verifies the public wrap before executing the Gas Tank-paid confidential deposit and apply", async () => {
    const response = await POST(request({
      action: "verify",
      amountBaseUnits: "1000000",
      signature: "s".repeat(88)
    }), { params });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "confidential_balance_verified",
      amountBaseUnits: "1000000",
      depositSignature: "d".repeat(88),
      applySignature: "a".repeat(88)
    });
    expect(mocks.verifyFinalizedReserveWrapFunding).toHaveBeenCalledWith({
      db: {},
      workspaceId: "workspace-a",
      walletAddress: "admin-wallet",
      amountBaseUnits: "1000000",
      signature: "s".repeat(88)
    });
    expect(mocks.completeWorkspaceReserveConfidentialFunding).toHaveBeenCalledWith({
      db: {},
      workspaceId: "workspace-a",
      fallbackAuthorityAddress: "admin-wallet",
      amountBaseUnits: "1000000",
      wrapSignature: "s".repeat(88)
    });
  });

  it("returns pending until confidential deposit and apply are both finalized", async () => {
    mocks.completeWorkspaceReserveConfidentialFunding.mockResolvedValue({
      status: "pending",
      wrapSignature: "s".repeat(88),
      amountBaseUnits: "1000000",
      phase: "apply",
      stage: "apply_submitted"
    });
    const response = await POST(request({
      action: "verify",
      amountBaseUnits: "1000000",
      signature: "s".repeat(88)
    }), { params });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: "pending",
      phase: "apply",
      stage: "apply_submitted"
    });
  });

  it("does not expose a funding transaction to a contributor", async () => {
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "contributor" });
    const response = await POST(request({
      action: "prepare",
      amountBaseUnits: "1000000"
    }), { params });
    expect(response.status).toBe(403);
    expect(mocks.prepareReserveWrapFunding).not.toHaveBeenCalled();
  });

  it("blocks funding for a read-only subscription", async () => {
    mocks.getWorkspaceSubscription.mockResolvedValue({ status: "archived" });
    const response = await POST(request({
      action: "prepare",
      amountBaseUnits: "1000000"
    }), { params });
    expect(response.status).toBe(409);
    expect(mocks.prepareReserveWrapFunding).not.toHaveBeenCalled();
  });

  it("preserves pending Token Wrap finality as a retryable result", async () => {
    mocks.verifyFinalizedReserveWrapFunding.mockRejectedValue(
      new mocks.MockReserveWrapFundingError("reserve_wrap_transaction_not_finalized", 202)
    );
    const response = await POST(request({
      action: "verify",
      amountBaseUnits: "1000000",
      signature: "s".repeat(88)
    }), { params });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      error: "reserve_wrap_transaction_not_finalized",
      retryable: true
    });
    expect(mocks.completeWorkspaceReserveConfidentialFunding).not.toHaveBeenCalled();
  });

  it("returns the active funding stage for the same administrator after reload", async () => {
    mocks.getActiveWorkspaceReserveFundingOperation.mockResolvedValue({
      transactionSignature: "s".repeat(88),
      status: "preparing",
      operationData: {
        walletAddress: "admin-wallet",
        amountBaseUnits: "1000000",
        stage: "deposit_submitted",
        depositSignature: "d".repeat(88)
      }
    });
    const response = await GET(getRequest(), { params });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "pending",
      wrapSignature: "s".repeat(88),
      amountBaseUnits: "1000000",
      phase: "deposit",
      stage: "deposit_submitted",
      depositSignature: "d".repeat(88)
    });
  });

  it("does not expose another administrator's in-progress funding operation", async () => {
    mocks.getActiveWorkspaceReserveFundingOperation.mockResolvedValue({
      transactionSignature: "s".repeat(88),
      status: "preparing",
      operationData: {
        walletAddress: "another-admin",
        amountBaseUnits: "1000000",
        stage: "deposit_submitted"
      }
    });
    const response = await GET(getRequest(), { params });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ status: "another_admin_pending" });
    await expect(response.json()).resolves.not.toHaveProperty("wrapSignature");
  });

  it("reports an insufficient Gas Tank balance without claiming funding is complete", async () => {
    mocks.completeWorkspaceReserveConfidentialFunding.mockRejectedValue(
      new mocks.MockWorkspaceReserveInitializationError("reserve_gas_tank_insufficient_funds", 409)
    );
    const response = await POST(request({
      action: "verify",
      amountBaseUnits: "1000000",
      signature: "s".repeat(88)
    }), { params });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "reserve_gas_tank_insufficient_funds",
      retryable: false
    });
  });
});
