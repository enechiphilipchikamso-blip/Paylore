import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertSameOrigin: vi.fn(), clearSessionCookie: vi.fn(), getDatabase: vi.fn(),
  getSessionState: vi.fn(), getWorkspaceForUser: vi.fn(), findWorkspaceContributorByWallet: vi.fn(),
  getContributorConfidentialAccount: vi.fn(), getCompletedContributorOffboardingByWallet: vi.fn(),
  hasOpenContributorPayrollAllocations: vi.fn(), completeContributorOffboarding: vi.fn(),
  verifyConfidentialAccountClose: vi.fn(), loadPayloreConfig: vi.fn()
}));
vi.mock("@paylore/database", () => ({
  completeContributorOffboarding: mocks.completeContributorOffboarding,
  getCompletedContributorOffboardingByWallet: mocks.getCompletedContributorOffboardingByWallet,
  findWorkspaceContributorByWallet: mocks.findWorkspaceContributorByWallet,
  getContributorConfidentialAccount: mocks.getContributorConfidentialAccount,
  getWorkspaceForUser: mocks.getWorkspaceForUser,
  hasOpenContributorPayrollAllocations: mocks.hasOpenContributorPayrollAllocations
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
  verifyConfidentialAccountClose: mocks.verifyConfidentialAccountClose
}));
import { POST } from "./route";
const context = { params: Promise.resolve({ workspaceId: "workspace-a" }) };
const closeSignature = "5".repeat(88);
function request(body: unknown) {
  return new Request("https://paylore.test/api/offboarding", {
    method: "POST", headers: { origin: "https://paylore.test", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("contributor self-offboarding route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.assertSameOrigin.mockImplementation(() => undefined);
    mocks.getDatabase.mockReturnValue({});
    mocks.getSessionState.mockResolvedValue({
      status: "authenticated", session: { userId: "contributor-user", walletAddress: "contributor-wallet" }
    });
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "contributor" });
    mocks.getCompletedContributorOffboardingByWallet.mockResolvedValue(null);
    mocks.findWorkspaceContributorByWallet.mockResolvedValue({ id: "contributor-a", lifecycle: "active" });
    mocks.getContributorConfidentialAccount.mockResolvedValue(null);
    mocks.hasOpenContributorPayrollAllocations.mockResolvedValue(false);
    mocks.completeContributorOffboarding.mockResolvedValue("completed");
    mocks.verifyConfidentialAccountClose.mockResolvedValue("token-account-a");
    mocks.loadPayloreConfig.mockReturnValue({ PAYLORE_WRAPPED_USDC_MINT: "wrapped-mint" });
  });

  it("preflights obligations before an on-chain close can occur", async () => {
    mocks.hasOpenContributorPayrollAllocations.mockResolvedValue(true);
    const response = await POST(request({ action: "preflight" }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "outstanding_compensation_obligation" });
    expect(mocks.verifyConfidentialAccountClose).not.toHaveBeenCalled();
    expect(mocks.completeContributorOffboarding).not.toHaveBeenCalled();
  });

  it("returns the close requirement only when the ready account belongs to this wallet", async () => {
    mocks.getContributorConfidentialAccount.mockResolvedValue({
      status: "ready", ownerWalletAddress: "contributor-wallet", tokenAccountAddress: "token-account-a"
    });
    const response = await POST(request({ action: "preflight" }), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "eligible_to_leave", requiresConfidentialAccountClose: true
    });
  });

  it("rejects preflight when the confidential account belongs to another wallet", async () => {
    mocks.getContributorConfidentialAccount.mockResolvedValue({
      status: "ready", ownerWalletAddress: "another-wallet", tokenAccountAddress: "token-account-a"
    });
    const response = await POST(request({ action: "preflight" }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "confidential_account_owner_mismatch" });
  });

  it("requires the exact acknowledgement", async () => {
    const response = await POST(request({ acknowledgement: "Leave", closeTransactionSignature: null }), context);
    expect(response.status).toBe(400);
    expect(mocks.completeContributorOffboarding).not.toHaveBeenCalled();
  });

  it("denies administrator roles on the contributor-only endpoint", async () => {
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "organization_admin" });
    const response = await POST(request({
      acknowledgement: "Acknowledge & Leave Workspace", closeTransactionSignature: null
    }), context);
    expect(response.status).toBe(403);
    expect(mocks.completeContributorOffboarding).not.toHaveBeenCalled();
  });

  it("requires a verified manual close when a confidential account is ready", async () => {
    mocks.getContributorConfidentialAccount.mockResolvedValue({
      status: "ready", ownerWalletAddress: "contributor-wallet", tokenAccountAddress: "token-account-a"
    });
    const response = await POST(request({
      acknowledgement: "Acknowledge & Leave Workspace", closeTransactionSignature: null
    }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "confidential_account_close_required" });
    expect(mocks.completeContributorOffboarding).not.toHaveBeenCalled();
  });

  it("rejects a close whose verified account differs from the recorded account", async () => {
    mocks.getContributorConfidentialAccount.mockResolvedValue({
      status: "ready", ownerWalletAddress: "contributor-wallet", tokenAccountAddress: "token-account-a"
    });
    mocks.verifyConfidentialAccountClose.mockResolvedValue("other-account");
    const response = await POST(request({
      acknowledgement: "Acknowledge & Leave Workspace", closeTransactionSignature: closeSignature
    }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "confidential_account_close_mismatch" });
    expect(mocks.completeContributorOffboarding).not.toHaveBeenCalled();
  });

  it("does not remove membership if close finality cannot be reconciled", async () => {
    mocks.getContributorConfidentialAccount.mockResolvedValue({
      status: "ready", ownerWalletAddress: "contributor-wallet", tokenAccountAddress: "token-account-a"
    });
    mocks.verifyConfidentialAccountClose.mockRejectedValue(new Error("private rpc detail"));
    const response = await POST(request({
      acknowledgement: "Acknowledge & Leave Workspace", closeTransactionSignature: closeSignature
    }), context);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("private rpc detail");
    expect(mocks.completeContributorOffboarding).not.toHaveBeenCalled();
  });

  it("records the verified manual-close disposition", async () => {
    mocks.getContributorConfidentialAccount.mockResolvedValue({
      status: "ready", ownerWalletAddress: "contributor-wallet", tokenAccountAddress: "token-account-a"
    });
    const response = await POST(request({
      acknowledgement: "Acknowledge & Leave Workspace", closeTransactionSignature: closeSignature
    }), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "left_workspace", replayed: false, manualAccountClose: true
    });
    expect(mocks.verifyConfidentialAccountClose).toHaveBeenCalledWith({
      signature: closeSignature, walletAddress: "contributor-wallet", mintAddress: "wrapped-mint"
    });
  });

  it("leaves without closing an account that has not been configured", async () => {
    const response = await POST(request({
      acknowledgement: "Acknowledge & Leave Workspace", closeTransactionSignature: null
    }), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "left_workspace", manualAccountClose: false
    });
    expect(mocks.verifyConfidentialAccountClose).not.toHaveBeenCalled();
  });

  it("replays completed departure without requiring membership again", async () => {
    mocks.getCompletedContributorOffboardingByWallet.mockResolvedValue({
      manualAccountClose: true, completedAt: new Date("2026-10-22T10:00:00.000Z")
    });
    mocks.getWorkspaceForUser.mockResolvedValue(null);
    const response = await POST(request({
      acknowledgement: "Acknowledge & Leave Workspace", closeTransactionSignature: closeSignature
    }), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "left_workspace", replayed: true, manualAccountClose: true
    });
    expect(mocks.completeContributorOffboarding).not.toHaveBeenCalled();
  });

  it("rejects oversized request bodies before database access", async () => {
    const response = await POST(new Request("https://paylore.test/api/offboarding", {
      method: "POST", headers: { origin: "https://paylore.test", "content-type": "application/json" },
      body: JSON.stringify({ action: "preflight", padding: "x".repeat(4096) })
    }), context);
    expect(response.status).toBe(413);
    expect(mocks.getWorkspaceForUser).not.toHaveBeenCalled();
  });

  it("fails closed without exposing provider failure details", async () => {
    mocks.hasOpenContributorPayrollAllocations.mockRejectedValue(new Error("provider-private-detail"));
    const response = await POST(request({ action: "preflight" }), context);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain("provider-private-detail");
  });
});
