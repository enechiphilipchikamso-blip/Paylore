import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertSameOrigin: vi.fn(),
  clearSessionCookie: vi.fn(),
  getDatabase: vi.fn(),
  getSessionState: vi.fn(),
  getWorkspaceDeletionState: vi.fn(),
  getWorkspaceGasTankOperation: vi.fn(),
  getWorkspaceGasTankOperationByIdempotencyKey: vi.fn(),
  recordPayrollClaimSubmission: vi.fn(),
  verifyPayrollClaimTransaction: vi.fn(),
  readSolanaRpc: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  getWorkspaceGasTankSponsorshipUsage: vi.fn(),
  getWorkspacePayrollRun: vi.fn(),
  getWorkspaceSubscription: vi.fn(),
  beginGasTankOperationAttempt: vi.fn(),
  updateGasTankOperationAttempt: vi.fn(),
  loadPayloreConfig: vi.fn(),
  getWorkspaceGasTankSnapshot: vi.fn(),
  withWorkspaceGasTankKey: vi.fn(),
  prepareSponsoredPayrollClaimTransaction: vi.fn()
}));

vi.mock("@paylore/database", () => ({
  beginGasTankOperationAttempt: mocks.beginGasTankOperationAttempt,
  getWorkspaceDeletionState: mocks.getWorkspaceDeletionState,
  getWorkspaceGasTankOperation: mocks.getWorkspaceGasTankOperation,
  getWorkspaceGasTankOperationByIdempotencyKey: mocks.getWorkspaceGasTankOperationByIdempotencyKey,
  recordPayrollClaimSubmission: mocks.recordPayrollClaimSubmission,
  getWorkspaceForUser: mocks.getWorkspaceForUser,
  getWorkspaceGasTankSponsorshipUsage: mocks.getWorkspaceGasTankSponsorshipUsage,
  getWorkspacePayrollRun: mocks.getWorkspacePayrollRun,
  getWorkspaceSubscription: mocks.getWorkspaceSubscription,
  updateGasTankOperationAttempt: mocks.updateGasTankOperationAttempt
}));
vi.mock("../../../../../../../../server/session", () => ({
  clearSessionCookie: mocks.clearSessionCookie,
  getSessionState: mocks.getSessionState
}));
vi.mock("../../../../../../../../server/db", () => ({ getDatabase: mocks.getDatabase }));
vi.mock("../../../../../../../../server/security", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
  RequestSecurityError: class RequestSecurityError extends Error {}
}));
vi.mock("../../../../../../../../server/config", () => ({
  loadPayloreConfig: mocks.loadPayloreConfig
}));
vi.mock("../../../../../../../../server/gas-tank", () => ({
  getWorkspaceGasTankSnapshot: mocks.getWorkspaceGasTankSnapshot,
  withWorkspaceGasTankKey: mocks.withWorkspaceGasTankKey
}));
vi.mock("../../../../../../../../server/solana/rpc", () => ({ readSolanaRpc: mocks.readSolanaRpc }));
vi.mock("../../../../../../../../server/solana/payroll-program-verification", () => ({ verifyPayrollClaimTransaction: mocks.verifyPayrollClaimTransaction }));
vi.mock("../../../../../../../../server/gas-tank-sponsorship", () => ({
  prepareSponsoredPayrollClaimTransaction: mocks.prepareSponsoredPayrollClaimTransaction
}));

import { POST } from "./route";

const context = { params: Promise.resolve({ workspaceId: "workspace-a", runId: "run-a" }) };
const claimId = "01".repeat(32);
const commitment = "ab".repeat(32);

function currentRequestDigest() {
  return createHash("sha256").update(JSON.stringify({
    workspaceId: "workspace-a",
    runId: "run-a",
    authorityAddress: "manager-wallet",
    programId: "payroll-program",
    allocationCommitment: commitment,
    claimIds: [claimId]
  })).digest("hex");
}

function preparedOperation(overrides: Record<string, unknown> = {}) {
  return {
    id: "operation-a",
    requestDigest: currentRequestDigest(),
    status: "prepared",
    transactionSignature: "5".repeat(64),
    feeLamports: "5000",
    lastValidBlockHeight: "120",
    operationData: {
      runId: "run-a",
      claimIds: [claimId],
      authorityAddress: "manager-wallet",
      programId: "payroll-program",
      allocationCommitment: commitment,
      claims: [{ claimId, claimAddress: "claim-pda" }],
      blockhash: "blockhash",
      transactionBase64: "AQIDBA=="
    },
    ...overrides
  };
}

function request(body: unknown) {
  return new Request("https://paylore.test/api/sponsor", {
    method: "POST",
    headers: { origin: "https://paylore.test", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("payroll sponsor route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertSameOrigin.mockImplementation(() => undefined);
    mocks.getDatabase.mockReturnValue({});
    mocks.getSessionState.mockResolvedValue({
      status: "authenticated",
      session: { userId: "manager-user", walletAddress: "manager-wallet" }
    });
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "organization_admin" });
    mocks.getWorkspaceDeletionState.mockResolvedValue(null);
    mocks.getWorkspaceGasTankOperation.mockResolvedValue(null);
    mocks.getWorkspaceGasTankOperationByIdempotencyKey.mockResolvedValue(null);
    mocks.verifyPayrollClaimTransaction.mockResolvedValue(undefined);
    mocks.recordPayrollClaimSubmission.mockResolvedValue({ status: "committed", submittedCount: 1, totalCount: 1 });
    mocks.readSolanaRpc.mockImplementation(async (method: string) => method === "getSignatureStatuses" ? { value: [null] } : 121);
    mocks.getWorkspaceSubscription.mockResolvedValue({ status: "active" });
    mocks.loadPayloreConfig.mockReturnValue({ PAYLORE_PAYROLL_PROGRAM_ID: "payroll-program" });
    mocks.getWorkspacePayrollRun.mockResolvedValue({
      run: {
        id: "run-a",
        status: "commit_pending",
        managerConfirmedAt: new Date("2026-10-20T00:00:00Z"),
        allocationCommitment: commitment
      },
      allocations: [{
        id: "allocation-a",
        claimId,
        contributorWalletAddress: "contributor-wallet",
        status: "draft"
      }]
    });
    mocks.getWorkspaceGasTankSnapshot.mockResolvedValue({
      address: "gas-tank-wallet",
      balanceLamports: "500000000",
      lowBalance: false,
      lastActivityAt: null,
      updatedAt: "2026-10-20T00:00:00Z"
    });
    mocks.getWorkspaceGasTankSponsorshipUsage.mockResolvedValue({
      feeLamports: 0n, operationCount: 0, overflow: false
    });
    mocks.beginGasTankOperationAttempt.mockResolvedValue({
      status: "started",
      operation: { id: "operation-a" }
    });
    mocks.updateGasTankOperationAttempt.mockResolvedValue(true);
    mocks.withWorkspaceGasTankKey.mockImplementation(async (_db, _workspaceId, operation) =>
      operation(new Uint8Array(64).fill(8))
    );
    mocks.prepareSponsoredPayrollClaimTransaction.mockResolvedValue({
      transactionBase64: "AQIDBA==",
      signature: "5".repeat(64),
      feeLamports: "5000",
      gasTankAddress: "gas-tank-wallet",
      claims: [{ claimId, claimAddress: "claim-pda" }],
      blockhash: "blockhash",
      lastValidBlockHeight: 123
    });
  });

  it("returns a bounded, server-prepared transaction for a confirmed workspace claim batch", async () => {
    const response = await POST(request({ action: "prepare", claimIds: [claimId] }), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      status: "prepared",
      operationId: "operation-a",
      signature: "5".repeat(64),
      feeLamports: "5000",
      claims: [{ claimId, claimAddress: "claim-pda" }]
    });
    expect(body.transactionBase64).toBe("AQIDBA==");
    expect(JSON.stringify(body)).not.toContain("privateKey");
    expect(mocks.prepareSponsoredPayrollClaimTransaction).toHaveBeenCalledOnce();
  });

  it("replays the same transaction while its blockhash remains valid", async () => {
    mocks.getWorkspaceGasTankOperationByIdempotencyKey.mockResolvedValue({
      id: "operation-a", requestDigest: currentRequestDigest(), status: "prepared",
      transactionSignature: "5".repeat(64), feeLamports: "5000", lastValidBlockHeight: "120",
      operationData: {
        runId: "run-a", claimIds: [claimId], authorityAddress: "manager-wallet",
        programId: "payroll-program", allocationCommitment: commitment,
        claims: [{ claimId, claimAddress: "claim-pda" }], blockhash: "blockhash",
        transactionBase64: "AQIDBA=="
      }
    });
    mocks.readSolanaRpc.mockImplementation(async (method: string) => method === "getSignatureStatuses" ? { value: [null] } : 120);
    const response = await POST(request({ action: "prepare", claimIds: [claimId] }), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ replayed: true, transactionBase64: "AQIDBA==" });
    expect(mocks.beginGasTankOperationAttempt).not.toHaveBeenCalled();
  });

  it("rejects an idempotency record created for a different request digest", async () => {
    mocks.getWorkspaceGasTankOperationByIdempotencyKey.mockResolvedValue({
      id: "operation-a", requestDigest: "wrong"
    });
    const response = await POST(request({ action: "prepare", claimIds: [claimId] }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "sponsorship_idempotency_conflict" });
    expect(mocks.recordPayrollClaimSubmission).not.toHaveBeenCalled();
  });

  it("reconciles a finalized sponsor operation after a retry sees an already committed run", async () => {
    mocks.getWorkspacePayrollRun.mockResolvedValue({
      run: {
        id: "run-a",
        status: "committed",
        managerConfirmedAt: new Date("2026-10-20T00:00:00Z"),
        allocationCommitment: commitment
      },
      allocations: [{
        id: "allocation-a",
        claimId,
        contributorWalletAddress: "contributor-wallet",
        claimAddress: "claim-pda",
        status: "unclaimed"
      }]
    });
    mocks.getWorkspaceGasTankOperationByIdempotencyKey.mockResolvedValue(
      preparedOperation({ status: "finalized" })
    );
    const response = await POST(request({ action: "prepare", claimIds: [claimId] }), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "reconciled",
      replayed: true,
      signature: "5".repeat(64)
    });
    expect(mocks.prepareSponsoredPayrollClaimTransaction).not.toHaveBeenCalled();
    expect(mocks.recordPayrollClaimSubmission).toHaveBeenCalledOnce();
  });

  it("never replays a still-live prepared transaction for an already committed run", async () => {
    mocks.getWorkspacePayrollRun.mockResolvedValue({
      run: {
        id: "run-a",
        status: "committed",
        managerConfirmedAt: new Date("2026-10-20T00:00:00Z"),
        allocationCommitment: commitment
      },
      allocations: [{
        id: "allocation-a",
        claimId,
        contributorWalletAddress: "contributor-wallet",
        claimAddress: "claim-pda",
        status: "unclaimed"
      }]
    });
    mocks.getWorkspaceGasTankOperationByIdempotencyKey.mockResolvedValue(preparedOperation());
    mocks.readSolanaRpc.mockImplementation(async (method: string) =>
      method === "getSignatureStatuses" ? { value: [null] } : 120
    );
    const response = await POST(request({ action: "prepare", claimIds: [claimId] }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "payroll_run_already_committed" });
    expect(mocks.prepareSponsoredPayrollClaimTransaction).not.toHaveBeenCalled();
    expect(mocks.beginGasTankOperationAttempt).not.toHaveBeenCalled();
  });

  it("rejects repeated claim IDs before reserving sponsorship budget", async () => {
    const response = await POST(request({ action: "prepare", claimIds: [claimId, claimId] }), context);
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({ error: "sponsored_claims_duplicate" });
    expect(mocks.beginGasTankOperationAttempt).not.toHaveBeenCalled();
    expect(mocks.prepareSponsoredPayrollClaimTransaction).not.toHaveBeenCalled();
  });

  it("scopes payroll run lookup to the workspace from the authorized route", async () => {
    mocks.getWorkspacePayrollRun.mockResolvedValue(null);
    const response = await POST(request({ action: "prepare", claimIds: [claimId] }), context);
    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toMatchObject({ error: "payroll_run_not_found" });
    expect(mocks.getWorkspacePayrollRun).toHaveBeenCalledWith({}, "workspace-a", "run-a");
    expect(mocks.beginGasTankOperationAttempt).not.toHaveBeenCalled();
  });

  it("reconciles a finalized sponsored transaction before returning success", async () => {
    mocks.getWorkspaceGasTankOperationByIdempotencyKey.mockResolvedValue(preparedOperation());
    mocks.readSolanaRpc.mockImplementation(async (method: string) =>
      method === "getSignatureStatuses"
        ? { value: [{ confirmationStatus: "finalized", err: null }] }
        : 121
    );
    const response = await POST(request({ action: "prepare", claimIds: [claimId] }), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "reconciled",
      signature: "5".repeat(64),
      replayed: true,
      submittedCount: 1,
      totalCount: 1
    });
    expect(mocks.verifyPayrollClaimTransaction).toHaveBeenCalledWith({
      signature: "5".repeat(64),
      authorityAddress: "manager-wallet",
      workspaceId: "workspace-a",
      allocationCommitment: commitment,
      claims: [{ claimId, claimAddress: "claim-pda", contributorAddress: "contributor-wallet" }]
    });
    expect(mocks.recordPayrollClaimSubmission).toHaveBeenCalledOnce();
  });

  it("records the actual chain fee before allowing a failed sponsored transaction to retry", async () => {
    mocks.getWorkspaceGasTankOperationByIdempotencyKey.mockResolvedValue(preparedOperation());
    mocks.readSolanaRpc.mockImplementation(async (method: string) => {
      if (method === "getSignatureStatuses") {
        return { value: [{ confirmationStatus: "finalized", err: { InstructionError: [0, "Custom"] } }] };
      }
      if (method === "getTransaction") {
        return { meta: { err: { InstructionError: [0, "Custom"] }, fee: 7_000 } };
      }
      return 121;
    });
    const response = await POST(request({ action: "prepare", claimIds: [claimId] }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "previous_sponsored_transaction_failed_retry_allowed",
      signature: "5".repeat(64),
      feeLamports: "7000"
    });
    expect(mocks.updateGasTankOperationAttempt).toHaveBeenCalledWith({}, expect.objectContaining({
      workspaceId: "workspace-a",
      operationId: "operation-a",
      status: "failed",
      transactionSignature: "5".repeat(64),
      feeLamports: "7000",
      failureCode: "finalized_chain_failure"
    }));
    expect(mocks.recordPayrollClaimSubmission).not.toHaveBeenCalled();
  });

  it("allows a fresh preparation after the manager funds an insufficient Gas Tank", async () => {
    mocks.getWorkspaceGasTankSnapshot
      .mockResolvedValueOnce({
        address: "gas-tank-wallet", balanceLamports: "0", lowBalance: true,
        lastActivityAt: null, updatedAt: "2026-10-20T00:00:00Z"
      })
      .mockResolvedValueOnce({
        address: "gas-tank-wallet", balanceLamports: "500000000", lowBalance: false,
        lastActivityAt: null, updatedAt: "2026-10-20T00:05:00Z"
      });
    mocks.beginGasTankOperationAttempt
      .mockResolvedValueOnce({ status: "gas_tank_insufficient_balance", operation: null })
      .mockResolvedValueOnce({ status: "started", operation: { id: "operation-retry" } });
    const first = await POST(request({ action: "prepare", claimIds: [claimId] }), context);
    expect(first.status).toBe(409);
    await expect(first.json()).resolves.toMatchObject({ error: "gas_tank_insufficient_balance" });
    const second = await POST(request({ action: "prepare", claimIds: [claimId] }), context);
    expect(second.status).toBe(200);
    await expect(second.json()).resolves.toMatchObject({ status: "prepared", operationId: "operation-retry" });
    expect(mocks.prepareSponsoredPayrollClaimTransaction).toHaveBeenCalledOnce();
  });

  it("rejects a request exceeding the UTF-8 byte limit before parsing JSON", async () => {
    const response = await POST(new Request("https://paylore.test/api/sponsor", {
      method: "POST",
      headers: { origin: "https://paylore.test", "content-type": "application/json" },
      body: JSON.stringify("💵".repeat(1_100))
    }), context);
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "request_too_large" });
    expect(mocks.getSessionState).not.toHaveBeenCalled();
  });

  it("rejects an oversized declared body before reading or authenticating it", async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode("{}"));
      }
    });
    const response = await POST(new Request("https://paylore.test/api/sponsor", {
      method: "POST",
      headers: {
        origin: "https://paylore.test",
        "content-type": "application/json",
        "content-length": "4097"
      },
      body,
      duplex: "half"
    } as RequestInit & { duplex: "half" }), context);
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({ error: "request_too_large" });
    expect(mocks.getSessionState).not.toHaveBeenCalled();
  });

  it("cancels a streamed body as soon as UTF-8 bytes exceed the limit", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify("💵".repeat(1_100))));
      },
      cancel() {
        cancelled = true;
      }
    });
    const response = await POST(new Request("https://paylore.test/api/sponsor", {
      method: "POST",
      headers: { origin: "https://paylore.test", "content-type": "application/json" },
      body,
      duplex: "half"
    } as RequestInit & { duplex: "half" }), context);
    expect(response.status).toBe(413);
    expect(cancelled).toBe(true);
    expect(mocks.getSessionState).not.toHaveBeenCalled();
  });

  it("does not prepare a sponsorship for a workspace without manager membership", async () => {
    mocks.getWorkspaceForUser.mockResolvedValue(null);
    const response = await POST(request({ action: "prepare", claimIds: [claimId] }), context);
    expect(response.status).toBe(403);
    expect(mocks.prepareSponsoredPayrollClaimTransaction).not.toHaveBeenCalled();
    expect(mocks.getWorkspaceGasTankSnapshot).not.toHaveBeenCalled();
  });

  it("does not leak internal exception text when sponsorship preparation fails", async () => {
    const secret = "internal-private-key-marker";
    mocks.withWorkspaceGasTankKey.mockRejectedValue(new Error(secret));
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const response = await POST(request({ action: "prepare", claimIds: [claimId] }), context);
      expect(response.status).toBe(503);
      const body = await response.text();
      expect(body).not.toContain(secret);
      expect(log).toHaveBeenCalledWith(JSON.stringify({ event: "gas_tank_sponsorship_failed" }));
      expect(log.mock.calls.flat().join(" ")).not.toContain(secret);
    } finally {
      log.mockRestore();
    }
  });

  it("does not create a second operation while a previous preparation is in flight", async () => {
    mocks.getWorkspaceGasTankOperationByIdempotencyKey.mockResolvedValue({
      id: "operation-a", requestDigest: currentRequestDigest(), status: "preparing",
      updatedAt: new Date()
    });
    const response = await POST(request({ action: "prepare", claimIds: [claimId] }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "gas_tank_operation_preparing" });
    expect(mocks.beginGasTankOperationAttempt).not.toHaveBeenCalled();
  });

  it("continues a manager-confirmed payroll run while earlier claim batches are submitting", async () => {
    mocks.getWorkspacePayrollRun.mockResolvedValue({
      run: {
        id: "run-a",
        status: "submitting",
        managerConfirmedAt: new Date("2026-10-20T00:00:00Z"),
        allocationCommitment: commitment
      },
      allocations: [{
        id: "allocation-b",
        claimId,
        contributorWalletAddress: "contributor-wallet",
        status: "draft"
      }]
    });
    const response = await POST(request({ action: "prepare", claimIds: [claimId] }), context);
    expect(response.status).toBe(200);
    expect(mocks.prepareSponsoredPayrollClaimTransaction).toHaveBeenCalledOnce();
  });

  it("does not release a prepared transaction while its blockhash remains valid", async () => {
    mocks.getWorkspaceGasTankOperation.mockResolvedValue({
      id: "operation-a", status: "prepared", transactionSignature: "5".repeat(64), lastValidBlockHeight: "120"
    });
    mocks.readSolanaRpc.mockImplementation(async (method: string) => method === "getSignatureStatuses" ? { value: [null] } : 120);
    const response = await POST(request({ action: "cancel", operationId: "d9f834d9-8597-4dbf-9bbd-e4a2a0d1f671" }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "sponsorship_transaction_still_live" });
    expect(mocks.updateGasTankOperationAttempt).not.toHaveBeenCalled();
  });

  it("releases a prepared reservation only after signature absence and blockhash expiry", async () => {
    mocks.getWorkspaceGasTankOperation.mockResolvedValue({
      id: "operation-a", status: "prepared", transactionSignature: "5".repeat(64), lastValidBlockHeight: "120"
    });
    const response = await POST(request({ action: "cancel", operationId: "d9f834d9-8597-4dbf-9bbd-e4a2a0d1f671" }), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "cancelled", reason: "recent_blockhash_expired" });
    expect(mocks.updateGasTankOperationAttempt).toHaveBeenCalledWith({}, expect.objectContaining({
      workspaceId: "workspace-a", operationId: "operation-a", status: "cancelled", failureCode: "recent_blockhash_expired"
    }));
  });

  it("rejects arbitrary serialized bytes or unknown actions", async () => {
    const response = await POST(request({
      action: "sign_transaction",
      transactionBase64: "attacker-controlled",
      claimIds: [claimId]
    }), context);
    expect(response.status).toBe(400);
    expect(mocks.prepareSponsoredPayrollClaimTransaction).not.toHaveBeenCalled();
  });

  it("requires an authenticated organization administrator", async () => {
    mocks.getSessionState.mockResolvedValue({ status: "anonymous" });
    const response = await POST(request({ action: "prepare", claimIds: [claimId] }), context);
    expect(response.status).toBe(401);
    expect(mocks.getWorkspaceForUser).not.toHaveBeenCalled();
  });

  it("rejects non-admin roles", async () => {
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "finance_auditor" });
    const response = await POST(request({ action: "prepare", claimIds: [claimId] }), context);
    expect(response.status).toBe(403);
    expect(mocks.prepareSponsoredPayrollClaimTransaction).not.toHaveBeenCalled();
  });

  it("returns the atomic budget rejection when reserved fees exceed the workspace balance", async () => {
    mocks.beginGasTankOperationAttempt.mockResolvedValue({
      status: "gas_tank_insufficient_balance", operation: null
    });
    const response = await POST(request({ action: "prepare", claimIds: [claimId] }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "gas_tank_insufficient_balance" });
    expect(mocks.prepareSponsoredPayrollClaimTransaction).not.toHaveBeenCalled();
  });

  it("returns a rate limit when concurrent reservations exhaust the daily budget", async () => {
    mocks.beginGasTankOperationAttempt.mockResolvedValue({
      status: "gas_tank_daily_sponsorship_limit", operation: null
    });
    const response = await POST(request({ action: "prepare", claimIds: [claimId] }), context);
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toMatchObject({ error: "gas_tank_daily_sponsorship_limit" });
    expect(mocks.prepareSponsoredPayrollClaimTransaction).not.toHaveBeenCalled();
  });

  it("returns an actionable conflict when the Gas Tank cannot cover fees", async () => {
    mocks.getWorkspaceGasTankSnapshot.mockResolvedValue({
      address: "gas-tank-wallet", balanceLamports: "0", lowBalance: true,
      lastActivityAt: null, updatedAt: "2026-10-20T00:00:00Z"
    });
    const response = await POST(request({ action: "prepare", claimIds: [claimId] }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "gas_tank_insufficient_balance" });
    expect(mocks.beginGasTankOperationAttempt).not.toHaveBeenCalled();
  });

  it("does not allow the same manager request to create a second attempt", async () => {
    mocks.beginGasTankOperationAttempt.mockResolvedValue({
      status: "preparing",
      operation: { id: "operation-a" }
    });
    const response = await POST(request({ action: "prepare", claimIds: [claimId] }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ error: "gas_tank_operation_already_prepared" });
    expect(mocks.prepareSponsoredPayrollClaimTransaction).not.toHaveBeenCalled();
  });
});
