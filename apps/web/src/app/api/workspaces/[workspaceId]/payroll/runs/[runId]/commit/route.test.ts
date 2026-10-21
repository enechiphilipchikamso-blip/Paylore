import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertSameOrigin: vi.fn(),
  clearSessionCookie: vi.fn(),
  getSessionState: vi.fn(),
  getDatabase: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  getWorkspacePayrollRun: vi.fn(),
  verifyPayrollClaimTransaction: vi.fn(),
  updateGasTankOperationAttempt: vi.fn(),
  recordPayrollClaimSubmission: vi.fn()
}));

vi.mock("@paylore/database", () => ({
  getWorkspaceForUser: mocks.getWorkspaceForUser,
  getWorkspacePayrollRun: mocks.getWorkspacePayrollRun,
  recordPayrollClaimSubmission: mocks.recordPayrollClaimSubmission,
  updateGasTankOperationAttempt: mocks.updateGasTankOperationAttempt
}));
vi.mock("../../../../../../../../server/session", () => ({
  clearSessionCookie: mocks.clearSessionCookie,
  getSessionState: mocks.getSessionState
}));
vi.mock("../../../../../../../../server/db", () => ({
  getDatabase: mocks.getDatabase
}));
vi.mock("../../../../../../../../server/security", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
  RequestSecurityError: class RequestSecurityError extends Error {}
}));
vi.mock("../../../../../../../../server/solana/payroll-program-verification", () => ({
  verifyPayrollClaimTransaction: mocks.verifyPayrollClaimTransaction
}));

import { POST } from "./route";

const context = {
  params: Promise.resolve({ workspaceId: "workspace-a", runId: "run-a" })
};
const claimId = "01".repeat(32);
const claimAddress = "claim-pda";
const signature = "5".repeat(64);
const sponsorOperationId = "d9f834d9-8597-4dbf-9bbd-e4a2a0d1f671";

function request(body: unknown) {
  return new Request("https://paylore.test/api/payroll/commit", {
    method: "POST",
    headers: { origin: "https://paylore.test", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("verified payroll claim commit", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.assertSameOrigin.mockImplementation(() => undefined);
    mocks.getDatabase.mockReturnValue({});
    mocks.getSessionState.mockResolvedValue({
      status: "authenticated",
      session: { userId: "manager-user", walletAddress: "manager-wallet" }
    });
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "organization_admin" });
    mocks.getWorkspacePayrollRun.mockResolvedValue({
      run: { allocationCommitment: "ab".repeat(32), status: "commit_pending" },
      allocations: [{ claimId, contributorWalletAddress: "contributor-wallet" }]
    });
    mocks.verifyPayrollClaimTransaction.mockResolvedValue(undefined);
    mocks.updateGasTankOperationAttempt.mockResolvedValue(true);
    mocks.recordPayrollClaimSubmission.mockResolvedValue({
      status: "committed",
      submittedCount: 1,
      totalCount: 1
    });
  });

  it("does not finalize a sponsorship or persist a claim when the signed tx signature differs", async () => {
    mocks.updateGasTankOperationAttempt.mockResolvedValue(false);
    const response = await POST(request({
      signature,
      sponsorOperationId,
      claims: [{ claimId, claimAddress }]
    }), context);
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "sponsorship_operation_signature_mismatch"
    });
    expect(mocks.verifyPayrollClaimTransaction).toHaveBeenCalledOnce();
    expect(mocks.updateGasTankOperationAttempt).toHaveBeenCalledWith({}, {
      workspaceId: "workspace-a",
      operationId: sponsorOperationId,
      status: "finalized",
      transactionSignature: signature
    });
    expect(mocks.recordPayrollClaimSubmission).not.toHaveBeenCalled();
  });

  it("persists claims only after chain verification and matched sponsorship finalization", async () => {
    const response = await POST(request({
      signature,
      sponsorOperationId,
      claims: [{ claimId, claimAddress }]
    }), context);
    expect(response.status).toBe(200);
    expect(mocks.verifyPayrollClaimTransaction).toHaveBeenCalledOnce();
    expect(mocks.updateGasTankOperationAttempt).toHaveBeenCalledOnce();
    expect(mocks.recordPayrollClaimSubmission).toHaveBeenCalledWith({}, {
      workspaceId: "workspace-a",
      runId: "run-a",
      signature,
      claims: [{ claimId, claimAddress }]
    });
  });

  it("does not require a sponsor operation for directly wallet-paid legacy transactions", async () => {
    const response = await POST(request({
      signature,
      claims: [{ claimId, claimAddress }]
    }), context);
    expect(response.status).toBe(200);
    expect(mocks.updateGasTankOperationAttempt).not.toHaveBeenCalled();
    expect(mocks.recordPayrollClaimSubmission).toHaveBeenCalledOnce();
  });

  it("rejects a claim that is not allocated to the requested payroll run", async () => {
    mocks.getWorkspacePayrollRun.mockResolvedValue({
      run: { allocationCommitment: "ab".repeat(32), status: "commit_pending" },
      allocations: []
    });
    const response = await POST(request({
      signature,
      claims: [{ claimId, claimAddress }]
    }), context);
    expect(response.status).toBe(400);
    expect(mocks.verifyPayrollClaimTransaction).not.toHaveBeenCalled();
    expect(mocks.recordPayrollClaimSubmission).not.toHaveBeenCalled();
  });
});
