import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertSameOrigin: vi.fn(),
  clearSessionCookie: vi.fn(),
  getDatabase: vi.fn(),
  getSessionState: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  findWorkspaceContributorByWallet: vi.fn(),
  getContributorConfidentialAccount: vi.fn(),
  recordVerifiedPublicCashOutLedger: vi.fn(),
  recordWorkspaceNonFinancialOutcome: vi.fn(),
  verifyFinalizedCashOutTransaction: vi.fn(),
  VerificationError: class VerificationError extends Error {
    constructor(readonly code: string, readonly statusCode: number) { super(code); }
  }
}));

vi.mock("@paylore/database", () => ({
  getWorkspaceForUser: mocks.getWorkspaceForUser,
  findWorkspaceContributorByWallet: mocks.findWorkspaceContributorByWallet,
  getContributorConfidentialAccount: mocks.getContributorConfidentialAccount,
  recordVerifiedPublicCashOutLedger: mocks.recordVerifiedPublicCashOutLedger,
  recordWorkspaceNonFinancialOutcome: mocks.recordWorkspaceNonFinancialOutcome
}));
vi.mock("../../../../../../server/db", () => ({ getDatabase: mocks.getDatabase }));
vi.mock("../../../../../../server/session", () => ({
  clearSessionCookie: mocks.clearSessionCookie,
  getSessionState: mocks.getSessionState
}));
vi.mock("../../../../../../server/security", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
  RequestSecurityError: class RequestSecurityError extends Error {}
}));
vi.mock("../../../../../../server/config", () => ({
  loadPayloreConfig: () => ({
    PAYLORE_WRAPPED_USDC_MINT: "wrapped-usdc-mint",
    PAYLORE_SUBSCRIPTION_USDC_MINT: "circle-usdc-mint",
    TOKEN_WRAP_PROGRAM_ID: "token-wrap-program"
  })
}));
vi.mock("../../../../../../server/solana/cash-out-ledger-verification", () => ({
  CashOutLedgerVerificationError: mocks.VerificationError,
  verifyFinalizedCashOutTransaction: mocks.verifyFinalizedCashOutTransaction
}));

import { POST } from "./route";

const context = { params: Promise.resolve({ workspaceId: "workspace-a" }) };
const signature = "5".repeat(88);
const request = (payload: Record<string, unknown>) => new Request(
  "https://paylore.test/api/cash-out-ledger",
  { method: "POST", headers: { origin: "https://paylore.test", "content-type": "application/json" }, body: JSON.stringify(payload) }
);

describe("public cash-out ledger reconciliation route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.assertSameOrigin.mockImplementation(() => undefined);
    mocks.getDatabase.mockReturnValue({});
    mocks.getSessionState.mockResolvedValue({
      status: "authenticated",
      session: { userId: "user-a", walletAddress: "contributor-wallet" }
    });
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "contributor" });
    mocks.findWorkspaceContributorByWallet.mockResolvedValue({
      id: "contributor-a", lifecycle: "active"
    });
    mocks.getContributorConfidentialAccount.mockResolvedValue({
      status: "ready",
      ownerWalletAddress: "contributor-wallet",
      tokenAccountAddress: "contributor-token-account"
    });
    mocks.verifyFinalizedCashOutTransaction.mockResolvedValue({
      amountBaseUnits: "1000000", mint: "wrapped-usdc-mint",
      sourceTokenAccount: "contributor-token-account",
      destinationTokenAccount: "contributor-token-account"
    });
    mocks.recordVerifiedPublicCashOutLedger.mockResolvedValue({ status: "finalized" });
    mocks.recordWorkspaceNonFinancialOutcome.mockResolvedValue({ status: "recorded" });
  });

  it("records only a server-verified withdrawal result for the authenticated contributor", async () => {
    const response = await POST(request({
      kind: "confidential_withdrawal", signature, amountBaseUnits: "1000000"
    }), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "finalized", kind: "confidential_withdrawal", signature
    });
    expect(mocks.verifyFinalizedCashOutTransaction).toHaveBeenCalledWith({
      kind: "confidential_withdrawal", signature, amountBaseUnits: "1000000",
      walletAddress: "contributor-wallet", tokenAccountAddress: "contributor-token-account",
      wrappedMint: "wrapped-usdc-mint", circleMint: null, tokenWrapProgramId: "token-wrap-program"
    });
    expect(mocks.recordVerifiedPublicCashOutLedger).toHaveBeenCalledWith({}, {
      workspaceId: "workspace-a", contributorId: "contributor-a",
      contributorWalletAddress: "contributor-wallet", kind: "confidential_withdrawal",
      signature, amountBaseUnits: "1000000", mint: "wrapped-usdc-mint",
      sourceTokenAccount: "contributor-token-account", destinationTokenAccount: "contributor-token-account"
    });
  });

  it("keeps the configured Circle mint scoped to unwrap and returns idempotent replay", async () => {
    mocks.verifyFinalizedCashOutTransaction.mockResolvedValue({
      amountBaseUnits: "2500000", mint: "circle-usdc-mint",
      sourceTokenAccount: "wrapped-source", destinationTokenAccount: "circle-destination"
    });
    mocks.recordVerifiedPublicCashOutLedger.mockResolvedValue({ status: "duplicate" });
    const response = await POST(request({
      kind: "circle_usdc_unwrap", signature, amountBaseUnits: "2500000"
    }), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "duplicate", kind: "circle_usdc_unwrap" });
    expect(mocks.verifyFinalizedCashOutTransaction).toHaveBeenCalledWith(expect.objectContaining({
      kind: "circle_usdc_unwrap", circleMint: "circle-usdc-mint"
    }));
  });

  it("rejects other workspace roles before chain verification", async () => {
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "organization_admin" });
    const response = await POST(request({
      kind: "confidential_withdrawal", signature, amountBaseUnits: "1000000"
    }), context);
    expect(response.status).toBe(403);
    expect(mocks.verifyFinalizedCashOutTransaction).not.toHaveBeenCalled();
    expect(mocks.recordVerifiedPublicCashOutLedger).not.toHaveBeenCalled();
  });

  it("rejects wallet/account mismatches without attempting a ledger insert", async () => {
    mocks.getContributorConfidentialAccount.mockResolvedValue({
      status: "ready",
      ownerWalletAddress: "someone-else",
      tokenAccountAddress: "contributor-token-account"
    });
    const response = await POST(request({
      kind: "confidential_withdrawal", signature, amountBaseUnits: "1000000"
    }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toEqual({ error: "contributor_confidential_account_not_ready" });
    expect(mocks.verifyFinalizedCashOutTransaction).not.toHaveBeenCalled();
    expect(mocks.recordVerifiedPublicCashOutLedger).not.toHaveBeenCalled();
  });

  it("does not create a finalized ledger response for an unverifiable transaction", async () => {
    mocks.verifyFinalizedCashOutTransaction.mockRejectedValue(
      new mocks.VerificationError("cash_out_balance_delta_invalid", 409)
    );
    const response = await POST(request({
      kind: "confidential_withdrawal", signature, amountBaseUnits: "1000000"
    }), context);
    expect(response.status).toBe(409);
    expect(mocks.recordVerifiedPublicCashOutLedger).not.toHaveBeenCalled();
    expect(mocks.recordWorkspaceNonFinancialOutcome).toHaveBeenCalledWith({}, expect.objectContaining({
      category: "cash_out",
      entryType: "cash_out_reconciliation_failed",
      status: "failed",
      transactionSignature: signature,
      metadata: { outcome: "failed", errorCode: "cash_out_balance_delta_invalid" }
    }));
  });

  it("rejects invalid amounts and oversized request bodies", async () => {
    const invalid = await POST(request({
      kind: "confidential_withdrawal", signature, amountBaseUnits: "0"
    }), context);
    expect(invalid.status).toBe(400);
    expect(mocks.verifyFinalizedCashOutTransaction).not.toHaveBeenCalled();

    const oversized = new Request("https://paylore.test/api/cash-out-ledger", {
      method: "POST",
      headers: { origin: "https://paylore.test", "content-type": "application/json" },
      body: JSON.stringify({ kind: "confidential_withdrawal", signature, amountBaseUnits: "1", padding: "x".repeat(3000) })
    });
    expect((await POST(oversized, context)).status).toBe(413);
  });
});
