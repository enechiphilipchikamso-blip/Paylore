import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  clearSessionCookie: vi.fn(), getSessionState: vi.fn(), getDatabase: vi.fn(),
  getWorkspaceForUser: vi.fn(), getWorkspaceSubscription: vi.fn(),
  prepareReserveWrapFunding: vi.fn(), verifyFinalizedReserveWrapFunding: vi.fn(),
  MockReserveWrapFundingError: class extends Error {
    constructor(readonly code: string, readonly statusCode: number) { super(code); }
  }
}));
vi.mock("@paylore/database", () => ({
  getWorkspaceForUser: mocks.getWorkspaceForUser, getWorkspaceSubscription: mocks.getWorkspaceSubscription
}));
vi.mock("../../../../../../../server/session", () => ({
  clearSessionCookie: mocks.clearSessionCookie, getSessionState: mocks.getSessionState
}));
vi.mock("../../../../../../../server/security", () => ({
  assertSameOrigin: vi.fn(), RequestSecurityError: class extends Error {}
}));
vi.mock("../../../../../../../server/db", () => ({ getDatabase: mocks.getDatabase }));
vi.mock("../../../../../../../server/solana/reserve-wrap-funding", () => ({
  prepareReserveWrapFunding: mocks.prepareReserveWrapFunding,
  verifyFinalizedReserveWrapFunding: mocks.verifyFinalizedReserveWrapFunding,
  ReserveWrapFundingError: mocks.MockReserveWrapFundingError
}));
import { POST } from "./route";

const params = Promise.resolve({ workspaceId: "workspace-a" });
function request(body: unknown) {
  return new Request("https://paylore.test/api/workspaces/workspace-a/settings/reserve/funding", {
    method: "POST", headers: { origin: "https://paylore.test", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}
describe("workspace Reserve ordinary-USDC wrap funding route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDatabase.mockReturnValue({});
    mocks.getSessionState.mockResolvedValue({
      status: "authenticated", session: { userId: "user-a", walletAddress: "admin-wallet" }
    });
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "organization_admin" });
    mocks.getWorkspaceSubscription.mockResolvedValue({ status: "active" });
    mocks.prepareReserveWrapFunding.mockResolvedValue({
      status: "prepared", walletAddress: "admin-wallet", reserveAddress: "reserve-address",
      reserveTokenAccountAddress: "reserve-token-account", wrappedMintAddress: "wrapped-mint",
      unwrappedMintAddress: "circle-mint", tokenWrapProgramAddress: "token-wrap-program",
      amountBaseUnits: "1000000"
    });
    mocks.verifyFinalizedReserveWrapFunding.mockResolvedValue({
      status: "wrapped_public_balance_verified", signature: "s".repeat(88), amountBaseUnits: "1000000",
      sourceTokenAccount: "source-account", escrowTokenAccount: "escrow-account",
      destinationTokenAccount: "reserve-token-account", slot: 123
    });
  });

  it("prepares only an authenticated administrator wallet transaction", async () => {
    const response = await POST(request({ action: "prepare", amountBaseUnits: "1000000" }), { params });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "prepared", walletAddress: "admin-wallet", reserveTokenAccountAddress: "reserve-token-account"
    });
    expect(mocks.prepareReserveWrapFunding).toHaveBeenCalledWith({
      db: {}, workspaceId: "workspace-a", walletAddress: "admin-wallet", amountBaseUnits: "1000000"
    });
  });

  it("does not expose a transaction to a non-admin", async () => {
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "contributor" });
    const response = await POST(request({ action: "prepare", amountBaseUnits: "1000000" }), { params });
    expect(response.status).toBe(403);
    expect(mocks.prepareReserveWrapFunding).not.toHaveBeenCalled();
  });

  it("blocks funding for a read-only subscription", async () => {
    mocks.getWorkspaceSubscription.mockResolvedValue({ status: "archived" });
    const response = await POST(request({ action: "prepare", amountBaseUnits: "1000000" }), { params });
    expect(response.status).toBe(409);
    expect(mocks.prepareReserveWrapFunding).not.toHaveBeenCalled();
  });

  it("preserves pending finality as a retryable verification result", async () => {
    mocks.verifyFinalizedReserveWrapFunding.mockRejectedValue(
      new mocks.MockReserveWrapFundingError("reserve_wrap_transaction_not_finalized", 202)
    );
    const response = await POST(request({
      action: "verify", amountBaseUnits: "1000000", signature: "s".repeat(88)
    }), { params });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      error: "reserve_wrap_transaction_not_finalized", retryable: true
    });
  });
});
