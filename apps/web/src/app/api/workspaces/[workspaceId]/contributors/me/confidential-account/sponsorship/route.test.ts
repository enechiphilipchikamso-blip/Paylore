import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertSameOrigin: vi.fn(),
  clearSessionCookie: vi.fn(),
  getDatabase: vi.fn(),
  getSessionState: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  findWorkspaceContributorByWallet: vi.fn(),
  getContributorConfidentialAccount: vi.fn(),
  getWorkspaceDeletionState: vi.fn(),
  getWorkspaceSubscription: vi.fn(),
  getWorkspaceGasTankSnapshot: vi.fn(),
  getWorkspaceGasTankOperationByIdempotencyKey: vi.fn(),
  getWorkspaceGasTankSponsorshipUsage: vi.fn(),
  listPreparedGasTankConfidentialSetupOperations: vi.fn(),
  beginGasTankOperationAttempt: vi.fn(),
  updateGasTankOperationAttempt: vi.fn(),
  withWorkspaceGasTankKey: vi.fn(),
  loadPayloreConfig: vi.fn(),
  inspectSponsoredConfidentialSetupTransaction: vi.fn(),
  submitSponsoredConfidentialSetupTransaction: vi.fn(),
  findAssociatedTokenPda: vi.fn(),
  readSolanaRpc: vi.fn(),
  assertSponsoredCost: vi.fn()
}));
vi.mock("@paylore/database", () => ({
  beginGasTankOperationAttempt: mocks.beginGasTankOperationAttempt,
  findWorkspaceContributorByWallet: mocks.findWorkspaceContributorByWallet,
  getContributorConfidentialAccount: mocks.getContributorConfidentialAccount,
  getWorkspaceDeletionState: mocks.getWorkspaceDeletionState,
  getWorkspaceForUser: mocks.getWorkspaceForUser,
  getWorkspaceGasTankOperationByIdempotencyKey: mocks.getWorkspaceGasTankOperationByIdempotencyKey,
  getWorkspaceGasTankSponsorshipUsage: mocks.getWorkspaceGasTankSponsorshipUsage,
  getWorkspaceSubscription: mocks.getWorkspaceSubscription,
  listPreparedGasTankConfidentialSetupOperations: mocks.listPreparedGasTankConfidentialSetupOperations,
  updateGasTankOperationAttempt: mocks.updateGasTankOperationAttempt
}));
vi.mock("@solana/kit", () => ({ address: (value: string) => value }));
vi.mock("@solana-program/token-2022", () => ({
  TOKEN_2022_PROGRAM_ADDRESS: "token-2022",
  findAssociatedTokenPda: mocks.findAssociatedTokenPda
}));
vi.mock("../../../../../../../../server/session", () => ({
  clearSessionCookie: mocks.clearSessionCookie,
  getSessionState: mocks.getSessionState
}));
vi.mock("../../../../../../../../server/security", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
  RequestSecurityError: class RequestSecurityError extends Error {}
}));
vi.mock("../../../../../../../../server/db", () => ({ getDatabase: mocks.getDatabase }));
vi.mock("../../../../../../../../server/config", () => ({ loadPayloreConfig: mocks.loadPayloreConfig }));
vi.mock("../../../../../../../../server/gas-tank", () => ({
  getWorkspaceGasTankSnapshot: mocks.getWorkspaceGasTankSnapshot,
  withWorkspaceGasTankKey: mocks.withWorkspaceGasTankKey
}));
vi.mock("../../../../../../../../server/solana/rpc", () => ({ readSolanaRpc: mocks.readSolanaRpc }));
vi.mock("../../../../../../../../server/gas-tank-sponsorship-policy", () => ({
  GasTankSponsorshipPolicyError: class GasTankSponsorshipPolicyError extends Error {
    constructor(readonly code: string) { super(code); }
  },
  MAX_CONFIDENTIAL_ACCOUNT_SETUP_RENT_LAMPORTS: 10_000_000n,
  MAX_DAILY_SPONSORED_FEE_LAMPORTS: 5_000_000n,
  MAX_DAILY_SPONSORED_OPERATIONS: 100,
  assertSponsoredCost: mocks.assertSponsoredCost
}));
vi.mock("../../../../../../../../server/confidential-account-sponsorship", () => ({
  inspectSponsoredConfidentialSetupTransaction: mocks.inspectSponsoredConfidentialSetupTransaction,
  submitSponsoredConfidentialSetupTransaction: mocks.submitSponsoredConfidentialSetupTransaction
}));

import { GasTankSponsorshipPolicyError } from "../../../../../../../../server/gas-tank-sponsorship-policy";
import { GET, POST } from "./route";
const context = { params: Promise.resolve({ workspaceId: "workspace-a" }) };
function request(body?: unknown) {
  return new Request("https://paylore.test/api/confidential-account/sponsorship", {
    method: body === undefined ? "GET" : "POST",
    headers: { origin: "https://paylore.test", "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

describe("contributor confidential-account sponsorship relay", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.assertSameOrigin.mockImplementation(() => undefined);
    mocks.getDatabase.mockReturnValue({});
    mocks.getSessionState.mockResolvedValue({
      status: "authenticated",
      session: { userId: "contributor-user", walletAddress: "contributor-wallet" }
    });
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "contributor" });
    mocks.findWorkspaceContributorByWallet.mockResolvedValue({ id: "contributor-a", lifecycle: "active" });
    mocks.getContributorConfidentialAccount.mockResolvedValue(null);
    mocks.getWorkspaceDeletionState.mockResolvedValue(null);
    mocks.getWorkspaceSubscription.mockResolvedValue({ status: "active" });
    mocks.getWorkspaceGasTankSnapshot.mockResolvedValue({
      address: "gas-tank", balanceLamports: "50000000", lowBalance: false
    });
    mocks.getWorkspaceGasTankOperationByIdempotencyKey.mockResolvedValue(null);
    mocks.getWorkspaceGasTankSponsorshipUsage.mockResolvedValue({
      feeLamports: 0n, operationCount: 0, reservedFeesLamports: 0n
    });
    mocks.listPreparedGasTankConfidentialSetupOperations.mockResolvedValue([]);
    mocks.findAssociatedTokenPda.mockResolvedValue(["token-account"]);
    mocks.loadPayloreConfig.mockReturnValue({ PAYLORE_WRAPPED_USDC_MINT: "wrapped-mint" });
    mocks.inspectSponsoredConfidentialSetupTransaction.mockResolvedValue({
      transaction: { messageBytes: Uint8Array.of(1), signatures: {} },
      messageBytes: Uint8Array.of(1),
      recentBlockhash: "recent-blockhash",
      feeLamports: 5_000n,
      reservedRentLamports: 10_000_000n,
      transactionBytes: 100
    });
    mocks.beginGasTankOperationAttempt.mockResolvedValue({
      status: "started",
      operation: { id: "operation-a", updatedAt: new Date("2026-10-22T00:00:00.000Z") }
    });
    mocks.withWorkspaceGasTankKey.mockImplementation(async (_db, _workspace, callback) =>
      callback(new Uint8Array(64))
    );
    mocks.submitSponsoredConfidentialSetupTransaction.mockResolvedValue({
      signature: "5".repeat(88), feeLamports: "5000"
    });
    mocks.updateGasTankOperationAttempt.mockResolvedValue(true);
    mocks.readSolanaRpc.mockResolvedValue({ value: [{ confirmationStatus: "finalized", err: null }] });
  });

  it("returns only the Gas Tank payer address for an eligible contributor", async () => {
    const response = await GET(request(), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      feePayerAddress: "gas-tank",
      mintAddress: "wrapped-mint"
    });
  });

  it("denies non-contributor roles before reading the Gas Tank", async () => {
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "organization_admin" });
    const response = await GET(request(), context);
    expect(response.status).toBe(403);
    expect(mocks.getWorkspaceGasTankSnapshot).not.toHaveBeenCalled();
  });

  it("reserves fees and account rent before signing or broadcasting", async () => {
    const response = await POST(request({ transactionBase64: "AQ==" }), context);
    expect(response.status).toBe(200);
    expect(mocks.beginGasTankOperationAttempt).toHaveBeenCalledWith({}, expect.objectContaining({
      workspaceId: "workspace-a",
      operationType: "confidential_account_setup",
      reservedFeeLamports: "5000",
      availableBalanceLamports: "50000000",
      operationData: expect.objectContaining({
        ownerAddress: "contributor-wallet",
        tokenAccountAddress: "token-account",
        reservedRentLamports: "10000000"
      })
    }));
    expect(mocks.submitSponsoredConfidentialSetupTransaction).toHaveBeenCalled();
    expect(mocks.updateGasTankOperationAttempt).toHaveBeenCalledWith({}, expect.objectContaining({
      status: "prepared",
      transactionSignature: "5".repeat(88),
      feeLamports: "5000"
    }));
  });

  it("does not submit if the policy engine reports insufficient balance", async () => {
    mocks.inspectSponsoredConfidentialSetupTransaction.mockRejectedValue(
      new GasTankSponsorshipPolicyError("gas_tank_insufficient_balance")
    );
    const response = await POST(request({ transactionBase64: "AQ==" }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "gas_tank_insufficient_balance" });
    expect(mocks.submitSponsoredConfidentialSetupTransaction).not.toHaveBeenCalled();
  });

  it("releases an expired prepared reservation and requires a fresh blockhash", async () => {
    const operation = {
      id: "operation-expired",
      status: "prepared",
      transactionSignature: "5".repeat(88),
      feeLamports: "5000",
      failureCode: null,
      updatedAt: new Date("2026-10-22T00:00:00.000Z"),
      operationData: {
        ownerAddress: "contributor-wallet",
        mintAddress: "wrapped-mint",
        tokenAccountAddress: "token-account",
        recentBlockhash: "recent-blockhash",
        reservedRentLamports: "10000000"
      }
    };
    mocks.listPreparedGasTankConfidentialSetupOperations.mockResolvedValue([operation]);
    mocks.getWorkspaceGasTankOperationByIdempotencyKey.mockResolvedValue({
      ...operation,
      status: "cancelled",
      failureCode: "recent_blockhash_expired"
    });
    mocks.readSolanaRpc.mockImplementation(async (method: string) =>
      method === "getSignatureStatuses"
        ? { value: [null] }
        : method === "isBlockhashValid"
          ? { value: false }
          : method === "getTransaction"
            ? null
            : { value: [] }
    );
    mocks.updateGasTankOperationAttempt.mockResolvedValueOnce(true);

    const response = await POST(request({ transactionBase64: "AQ==" }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "confidential_setup_blockhash_expired",
      action: "prepare_fresh_transaction"
    });
    expect(mocks.updateGasTankOperationAttempt).toHaveBeenCalledWith({}, expect.objectContaining({
      operationId: "operation-expired",
      status: "cancelled",
      failureCode: "recent_blockhash_expired",
      transactionSignature: "5".repeat(88)
    }));
    expect(mocks.submitSponsoredConfidentialSetupTransaction).not.toHaveBeenCalled();
  });

  it("does not release or resubmit a stale reservation when another request wins the expiry compare-and-swap", async () => {
    const operation = {
      id: "operation-stale",
      status: "prepared",
      transactionSignature: "5".repeat(88),
      feeLamports: "5000",
      failureCode: null,
      updatedAt: new Date("2026-10-22T00:00:00.000Z"),
      operationData: {
        ownerAddress: "contributor-wallet",
        mintAddress: "wrapped-mint",
        tokenAccountAddress: "token-account",
        recentBlockhash: "recent-blockhash",
        reservedRentLamports: "10000000"
      }
    };
    mocks.listPreparedGasTankConfidentialSetupOperations.mockResolvedValue([operation]);
    mocks.getWorkspaceGasTankOperationByIdempotencyKey.mockResolvedValue(operation);
    mocks.readSolanaRpc.mockImplementation(async (method: string) =>
      method === "getSignatureStatuses"
        ? { value: [null] }
        : method === "getTransaction"
          ? null
          : method === "isBlockhashValid"
            ? { value: false }
            : { value: [] }
    );
    mocks.updateGasTankOperationAttempt.mockResolvedValue(false);

    const response = await POST(request({ transactionBase64: "AQ==" }), context);
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      signature: "5".repeat(88),
      status: "pending",
      error: "confidential_setup_sponsorship_pending"
    });
    expect(mocks.updateGasTankOperationAttempt).toHaveBeenCalledWith({}, expect.objectContaining({
      operationId: "operation-stale",
      status: "cancelled",
      expectedUpdatedAt: operation.updatedAt
    }));
    expect(mocks.submitSponsoredConfidentialSetupTransaction).not.toHaveBeenCalled();
  });

  it("does not allow an already-ready account to create a new sponsored setup", async () => {
    mocks.getContributorConfidentialAccount.mockResolvedValue({ status: "ready" });
    const response = await POST(request({ transactionBase64: "AQ==" }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "confidential_account_already_ready"
    });
    expect(mocks.submitSponsoredConfidentialSetupTransaction).not.toHaveBeenCalled();
  });
});
