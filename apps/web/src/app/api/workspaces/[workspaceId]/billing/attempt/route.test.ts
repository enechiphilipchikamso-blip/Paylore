import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: {},
  userId: "admin-user",
  attempt: {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspaceId: "workspace-a",
    userId: "admin-user",
    payerWalletAddress: "payer-wallet",
    recipient: "subscription-recipient",
    mint: "usdc-mint",
    amountBaseUnits: "49000000",
    memo: "Paylore activation attempt test | workspace workspace-a",
    blockhash: "recent-blockhash",
    lastValidBlockHeight: 200,
    status: "submitted",
    signature: "5".repeat(64) as string | null,
    createdAt: new Date("2026-10-24T08:00:00.000Z"),
    expiresAt: new Date("2026-10-24T08:01:30.000Z")
  },
  getSessionState: vi.fn(),
  clearSessionCookie: vi.fn(),
  assertSameOrigin: vi.fn(),
  getDatabase: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  getSubscriptionPaymentAttempt: vi.fn(),
  recordSubscriptionPaymentAttemptSignature: vi.fn(),
  updateSubscriptionPaymentAttemptStatus: vi.fn(),
  applyVerifiedSubscriptionPayment: vi.fn(),
  verifySubscriptionPayment: vi.fn(),
  readSolanaRpc: vi.fn(),
  assessAmbiguousPaymentAttempt: vi.fn()
}));

vi.mock("@paylore/database", () => ({
  applyVerifiedSubscriptionPayment: mocks.applyVerifiedSubscriptionPayment,
  getSubscriptionPaymentAttempt: mocks.getSubscriptionPaymentAttempt,
  getWorkspaceForUser: mocks.getWorkspaceForUser,
  recordSubscriptionPaymentAttemptSignature: mocks.recordSubscriptionPaymentAttemptSignature,
  updateSubscriptionPaymentAttemptStatus: mocks.updateSubscriptionPaymentAttemptStatus
}));
vi.mock("../../../../../../server/db", () => ({ getDatabase: mocks.getDatabase }));
vi.mock("../../../../../../server/security", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
  RequestSecurityError: class RequestSecurityError extends Error {}
}));
vi.mock("../../../../../../server/session", () => ({
  getSessionState: mocks.getSessionState,
  clearSessionCookie: mocks.clearSessionCookie
}));
vi.mock("../../../../../../server/solana/payment-verification", () => ({
  PaymentVerificationError: class PaymentVerificationError extends Error {
    readonly reason: string;
    constructor(reason: string) {
      super("Payment could not be verified.");
      this.reason = reason;
    }
  },
  verifySubscriptionPayment: mocks.verifySubscriptionPayment
}));
vi.mock("../../../../../../server/solana/rpc", () => ({ readSolanaRpc: mocks.readSolanaRpc }));
vi.mock("../../../../../../server/solana/payment-attempt-reconciliation", () => ({
  PAYMENT_ATTEMPT_SIGNATURE_SCAN_LIMIT: 1000,
  assessAmbiguousPaymentAttempt: mocks.assessAmbiguousPaymentAttempt
}));

import { POST } from "./route";
import { PaymentVerificationError } from "../../../../../../server/solana/payment-verification";

const WORKSPACE_ID = "workspace-a";
const ATTEMPT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SIGNATURE = "5".repeat(64);
const FAILED_SIGNATURE = "6".repeat(64);
const PAYER = "payer-wallet";
const MEMO = "Paylore activation attempt test | workspace workspace-a";
const VERIFIED = {
  signature: SIGNATURE,
  payerAddress: PAYER,
  recipient: "subscription-recipient",
  mint: "usdc-mint",
  amountBaseUnits: "49000000"
};

function request(body: unknown) {
  return new Request("https://paylore.test/api/workspaces/workspace-a/billing/attempt", {
    method: "POST",
    headers: { origin: "https://paylore.test", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}
const context = { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(mocks.attempt, {
    id: ATTEMPT_ID,
    workspaceId: WORKSPACE_ID,
    userId: "admin-user",
    payerWalletAddress: PAYER,
    recipient: "subscription-recipient",
    mint: "usdc-mint",
    amountBaseUnits: "49000000",
    memo: MEMO,
    blockhash: "recent-blockhash",
    lastValidBlockHeight: 200,
    status: "submitted",
    signature: SIGNATURE,
    createdAt: new Date("2026-10-24T08:00:00.000Z"),
    expiresAt: new Date("2026-10-24T08:01:30.000Z")
  });
  mocks.getSessionState.mockResolvedValue({
    status: "authenticated",
    session: { userId: "admin-user", walletAddress: PAYER }
  });
  mocks.clearSessionCookie.mockResolvedValue(undefined);
  mocks.assertSameOrigin.mockImplementation(() => undefined);
  mocks.getDatabase.mockReturnValue(mocks.db);
  mocks.getWorkspaceForUser.mockResolvedValue({ role: "organization_admin" });
  mocks.getSubscriptionPaymentAttempt.mockImplementation(async () => ({ ...mocks.attempt }));
  mocks.recordSubscriptionPaymentAttemptSignature.mockImplementation(async ({ signature }: { signature: string }) => ({
    ...mocks.attempt,
    status: "submitted",
    signature
  }));
  mocks.updateSubscriptionPaymentAttemptStatus.mockImplementation(async (input: Record<string, unknown>) => ({
    ...mocks.attempt,
    status: input.status,
    signature: input.signature
  }));
  mocks.applyVerifiedSubscriptionPayment.mockResolvedValue({
    duplicate: false,
    status: "active",
    periodEnd: new Date("2026-11-24T08:00:00.000Z")
  });
  mocks.verifySubscriptionPayment.mockResolvedValue(VERIFIED);
  mocks.readSolanaRpc.mockImplementation(async (method: string) => {
    if (method === "getBlockHeight") return 201;
    return [];
  });
  mocks.assessAmbiguousPaymentAttempt.mockReturnValue({ kind: "safe_to_retry" });
});

describe("subscription payment attempt reconciliation route", () => {
  it("activates only after finalized transaction verification uses the stored attempt memo", async () => {
    const response = await POST(request({ attemptId: ATTEMPT_ID, signature: SIGNATURE }), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "active" });
    expect(mocks.verifySubscriptionPayment).toHaveBeenCalledWith(SIGNATURE, PAYER, MEMO);
    expect(mocks.applyVerifiedSubscriptionPayment).toHaveBeenCalledWith(
      mocks.db,
      expect.objectContaining({
        workspaceId: WORKSPACE_ID,
        userId: "admin-user",
        signature: SIGNATURE,
        mint: "usdc-mint",
        recipient: "subscription-recipient",
        amountBaseUnits: "49000000"
      })
    );
    expect(mocks.updateSubscriptionPaymentAttemptStatus).toHaveBeenCalledWith(mocks.db, {
      attemptId: ATTEMPT_ID,
      status: "confirmed",
      signature: SIGNATURE
    });
  });

  it("does not activate when the transaction does not match the prepared memo", async () => {
    mocks.verifySubscriptionPayment.mockRejectedValueOnce(new PaymentVerificationError("wrong_payment"));
    const response = await POST(request({ attemptId: ATTEMPT_ID, signature: SIGNATURE }), context);
    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({ error: "payment_could_not_be_verified" });
    expect(mocks.applyVerifiedSubscriptionPayment).not.toHaveBeenCalled();
    expect(mocks.updateSubscriptionPaymentAttemptStatus).toHaveBeenCalledWith(mocks.db, {
      attemptId: ATTEMPT_ID,
      status: "failed",
      signature: SIGNATURE
    });
  });

  it("leaves a payment attempt reconcilable when verification configuration is unavailable", async () => {
    mocks.verifySubscriptionPayment.mockRejectedValueOnce(new PaymentVerificationError("configuration"));
    const response = await POST(request({ attemptId: ATTEMPT_ID, signature: SIGNATURE }), context);
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "payment_configuration_incomplete" });
    expect(mocks.applyVerifiedSubscriptionPayment).not.toHaveBeenCalled();
    expect(mocks.updateSubscriptionPaymentAttemptStatus).not.toHaveBeenCalled();
  });

  it("returns active when a concurrent verifier already confirmed the payment", async () => {
    mocks.verifySubscriptionPayment.mockRejectedValueOnce(new PaymentVerificationError("wrong_payment"));
    mocks.getSubscriptionPaymentAttempt
      .mockResolvedValueOnce({ ...mocks.attempt })
      .mockResolvedValueOnce({ ...mocks.attempt, status: "confirmed" });
    mocks.updateSubscriptionPaymentAttemptStatus.mockResolvedValueOnce(null);

    const response = await POST(request({ attemptId: ATTEMPT_ID, signature: SIGNATURE }), context);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "active" });
    expect(mocks.applyVerifiedSubscriptionPayment).not.toHaveBeenCalled();
  });

  it("keeps missing finalized transaction evidence in reconciliation rather than activating", async () => {
    mocks.verifySubscriptionPayment.mockRejectedValueOnce(new PaymentVerificationError("not_found"));
    const response = await POST(request({ attemptId: ATTEMPT_ID, signature: SIGNATURE }), context);
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: "reconciliation_required" });
    expect(mocks.applyVerifiedSubscriptionPayment).not.toHaveBeenCalled();
  });

  it("does not verify or activate an attempt that belongs to another workspace", async () => {
    mocks.getSubscriptionPaymentAttempt.mockResolvedValueOnce({
      ...mocks.attempt,
      workspaceId: "workspace-b"
    });
    const response = await POST(request({ attemptId: ATTEMPT_ID, signature: SIGNATURE }), context);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "payment_attempt_not_found" });
    expect(mocks.verifySubscriptionPayment).not.toHaveBeenCalled();
    expect(mocks.applyVerifiedSubscriptionPayment).not.toHaveBeenCalled();
  });

  it("records the actual signature of a finalized failed wallet transaction before offering a safe retry", async () => {
    mocks.attempt.status = "prepared";
    mocks.attempt.signature = null;
    mocks.readSolanaRpc.mockImplementation(async (method: string) => {
      if (method === "getBlockHeight") return 201;
      if (method === "getSignaturesForAddress") {
        return [{
          signature: FAILED_SIGNATURE,
          slot: 20,
          err: null,
          blockTime: Math.floor(Date.now() / 1000)
        }];
      }
      if (method === "getTransaction") {
        return {
          transaction: { message: { instructions: [{ program: "spl-memo", parsed: MEMO }] } },
          meta: { err: { InstructionError: [0, "Custom"] } }
        };
      }
      return [];
    });
    mocks.assessAmbiguousPaymentAttempt.mockReturnValue({
      kind: "submitted",
      signature: FAILED_SIGNATURE,
      failedOnChain: true
    });

    const response = await POST(request({ attemptId: ATTEMPT_ID }), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "safe_to_retry" });
    expect(mocks.recordSubscriptionPaymentAttemptSignature).toHaveBeenCalledWith(mocks.db, {
      attemptId: ATTEMPT_ID,
      signature: FAILED_SIGNATURE
    });
    expect(mocks.updateSubscriptionPaymentAttemptStatus).toHaveBeenCalledWith(mocks.db, {
      attemptId: ATTEMPT_ID,
      status: "failed",
      signature: FAILED_SIGNATURE
    });
    expect(mocks.applyVerifiedSubscriptionPayment).not.toHaveBeenCalled();
  });
});
