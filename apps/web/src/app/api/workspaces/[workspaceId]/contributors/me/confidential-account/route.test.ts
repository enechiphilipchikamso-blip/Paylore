import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  assertSameOrigin: vi.fn(), clearSessionCookie: vi.fn(), getDatabase: vi.fn(),
  getSessionState: vi.fn(), getWorkspaceForUser: vi.fn(), findWorkspaceContributorByWallet: vi.fn(),
  recordContributorConfidentialAccountSetup: vi.fn(),
  finalizeGasTankConfidentialAccountSetupForVerifiedAccount: vi.fn(),
  verifyConfidentialAccountSetup: vi.fn(), loadPayloreConfig: vi.fn()
}));
vi.mock("@paylore/database", () => ({
  findWorkspaceContributorByWallet: mocks.findWorkspaceContributorByWallet,
  recordContributorConfidentialAccountSetup: mocks.recordContributorConfidentialAccountSetup,
  finalizeGasTankConfidentialAccountSetupForVerifiedAccount: mocks.finalizeGasTankConfidentialAccountSetupForVerifiedAccount,
  getContributorConfidentialAccount: vi.fn(), getContributorOffboardingStatus: vi.fn(),
  getWorkspaceForUser: mocks.getWorkspaceForUser, hasOpenContributorPayrollAllocations: vi.fn()
}));
vi.mock("../../../../../../../server/db", () => ({ getDatabase: mocks.getDatabase }));
vi.mock("../../../../../../../server/session", () => ({
  clearSessionCookie: mocks.clearSessionCookie, getSessionState: mocks.getSessionState
}));
vi.mock("../../../../../../../server/security", () => ({
  assertSameOrigin: mocks.assertSameOrigin, RequestSecurityError: class RequestSecurityError extends Error {}
}));
vi.mock("../../../../../../../server/config", () => ({ loadPayloreConfig: mocks.loadPayloreConfig }));
vi.mock("../../../../../../../server/solana/confidential-account-verification", () => ({
  ConfidentialAccountVerificationError: class ConfidentialAccountVerificationError extends Error {
    constructor(readonly code: string) { super(code); }
  },
  verifyConfidentialAccountSetup: mocks.verifyConfidentialAccountSetup
}));
import { GET, POST } from "./route";
const context = { params: Promise.resolve({ workspaceId: "workspace-a" }) };
const signature = "5".repeat(88);
function request(body: unknown) {
  return new Request("https://paylore.test/api/confidential-account", {
    method: "POST", headers: { origin: "https://paylore.test", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}
describe("contributor confidential-account setup route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.assertSameOrigin.mockImplementation(() => undefined);
    mocks.getDatabase.mockReturnValue({});
    mocks.getSessionState.mockResolvedValue({
      status: "authenticated", session: { userId: "contributor-user", walletAddress: "contributor-wallet" }
    });
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "contributor" });
    mocks.findWorkspaceContributorByWallet.mockResolvedValue({ id: "contributor-a", lifecycle: "active" });
    mocks.loadPayloreConfig.mockReturnValue({ PAYLORE_WRAPPED_USDC_MINT: "wrapped-mint" });
    mocks.verifyConfidentialAccountSetup.mockResolvedValue("token-account-a");
    mocks.recordContributorConfidentialAccountSetup.mockResolvedValue({
      contributorId: "contributor-a", tokenAccountAddress: "token-account-a", status: "ready"
    });
    mocks.finalizeGasTankConfidentialAccountSetupForVerifiedAccount.mockResolvedValue(true);
  });
  it("denies confidential-account access after workspace membership has been removed", async () => {
    mocks.getWorkspaceForUser.mockResolvedValue(null);
    const response = await GET(
      new Request("https://paylore.test/api/confidential-account"),
      context
    );
    expect(response.status).toBe(403);
    expect(mocks.findWorkspaceContributorByWallet).not.toHaveBeenCalled();
  });

  it("records ready only after owner-bound finalized setup and extension readiness are verified", async () => {
    const response = await POST(request({ signature }), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      account: { tokenAccountAddress: "token-account-a", status: "ready" }
    });
    expect(mocks.verifyConfidentialAccountSetup).toHaveBeenCalledWith({
      signature, walletAddress: "contributor-wallet", mintAddress: "wrapped-mint"
    });
    expect(mocks.recordContributorConfidentialAccountSetup).toHaveBeenCalledWith({}, expect.objectContaining({
      workspaceId: "workspace-a", contributorId: "contributor-a",
      ownerWalletAddress: "contributor-wallet", tokenAccountAddress: "token-account-a",
      transactionSignature: signature
    }));
    expect(mocks.finalizeGasTankConfidentialAccountSetupForVerifiedAccount).toHaveBeenCalledWith({}, {
      workspaceId: "workspace-a",
      transactionSignature: signature,
      ownerAddress: "contributor-wallet",
      mintAddress: "wrapped-mint",
      tokenAccountAddress: "token-account-a"
    });
  });
  it("does not persist ready when the confidential extension is not ready", async () => {
    mocks.verifyConfidentialAccountSetup.mockRejectedValue(
      Object.assign(new Error("not ready"), { code: "confidential_account_not_ready" })
    );
    const response = await POST(request({ signature }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "confidential_account_not_ready" });
    expect(mocks.recordContributorConfidentialAccountSetup).not.toHaveBeenCalled();
  });
  it("denies a non-contributor membership", async () => {
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "organization_admin" });
    const response = await POST(request({ signature }), context);
    expect(response.status).toBe(403);
    expect(mocks.verifyConfidentialAccountSetup).not.toHaveBeenCalled();
  });
  it("rejects malformed signatures without persisting account state", async () => {
    const response = await POST(request({ signature: "short" }), context);
    expect(response.status).toBe(400);
    expect(mocks.recordContributorConfidentialAccountSetup).not.toHaveBeenCalled();
  });
});
