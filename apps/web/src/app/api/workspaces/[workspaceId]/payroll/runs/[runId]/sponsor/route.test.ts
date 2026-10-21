import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertSameOrigin: vi.fn(),
  clearSessionCookie: vi.fn(),
  getDatabase: vi.fn(),
  getSessionState: vi.fn(),
  getWorkspaceDeletionState: vi.fn(),
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
vi.mock("../../../../../../../../server/gas-tank-sponsorship", () => ({
  prepareSponsoredPayrollClaimTransaction: mocks.prepareSponsoredPayrollClaimTransaction
}));

import { POST } from "./route";

const context = { params: Promise.resolve({ workspaceId: "workspace-a", runId: "run-a" }) };
const claimId = "01".repeat(32);
const commitment = "ab".repeat(32);

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
