import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockRequestSecurityError extends Error {}
  class MockPayrollConfidentialRecoveryError extends Error {
    constructor(readonly code: string, readonly statusCode: number) {
      super(code);
    }
  }
  return {
    MockRequestSecurityError,
    MockPayrollConfidentialRecoveryError,
    assertSameOrigin: vi.fn(),
    clearSessionCookie: vi.fn(),
    getDatabase: vi.fn(),
    getSessionState: vi.fn(),
    getWorkspaceForUser: vi.fn(),
    getPayrollClaimEscrow: vi.fn(),
    recoverPayrollAllocation: vi.fn()
  };
});

vi.mock("@paylore/database", () => ({
  getWorkspaceForUser: mocks.getWorkspaceForUser,
  getPayrollClaimEscrow: mocks.getPayrollClaimEscrow
}));

vi.mock("../../../../../../../../../../server/session", () => ({
  clearSessionCookie: mocks.clearSessionCookie,
  getSessionState: mocks.getSessionState
}));

vi.mock("../../../../../../../../../../server/db", () => ({
  getDatabase: mocks.getDatabase
}));

vi.mock("../../../../../../../../../../server/solana/payroll-confidential-recovery", () => ({
  PayrollConfidentialRecoveryError: mocks.MockPayrollConfidentialRecoveryError,
  recoverPayrollAllocation: mocks.recoverPayrollAllocation
}));

vi.mock("../../../../../../../../../../server/security", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
  RequestSecurityError: mocks.MockRequestSecurityError
}));

import { GET, POST } from "./route";

const routeContext = {
  params: Promise.resolve({
    workspaceId: "workspace-a",
    runId: "run-a",
    allocationId: "allocation-a"
  })
};

function request(body?: unknown) {
  return new Request("https://paylore.test/api/recovery", {
    method: "POST",
    headers: { origin: "https://paylore.test", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

describe("payroll recovery route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDatabase.mockReturnValue({});
    mocks.getSessionState.mockResolvedValue({
      status: "authenticated",
      session: { userId: "user-a", walletAddress: "wallet-a" }
    });
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "organization_admin" });
    mocks.getPayrollClaimEscrow.mockResolvedValue({
      workspaceId: "workspace-a",
      payrollRunId: "run-a",
      status: "recovery_pending",
      recoveryReason: "payroll_correction",
      recoveryReasonNote: null,
      recoverySignature: "recovery-signature",
      recoveryApplySignature: null,
      recoveryContextSignatures: [],
      encryptedPrivateKey: "must-not-leak"
    });
    mocks.recoverPayrollAllocation.mockResolvedValue({
      status: "recovered",
      signature: "recovery-signature"
    });
  });

  it("restores the existing admin recovery attempt without exposing custody fields", async () => {
    const response = await GET(new Request("https://paylore.test/api/recovery"), {
      params: routeContext.params
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      status: "recovery_pending",
      reason: "payroll_correction",
      recoverySignature: "recovery-signature"
    });
    expect(JSON.stringify(body)).not.toContain("must-not-leak");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("requires authentication before reading recovery state", async () => {
    mocks.getSessionState.mockResolvedValue({ status: "anonymous" });
    const response = await GET(new Request("https://paylore.test/api/recovery"), {
      params: routeContext.params
    });
    expect(response.status).toBe(401);
    expect(mocks.clearSessionCookie).toHaveBeenCalledOnce();
    expect(mocks.getPayrollClaimEscrow).not.toHaveBeenCalled();
  });

  it("does not expose recovery status to non-admin workspace members", async () => {
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "finance_auditor" });
    const response = await GET(new Request("https://paylore.test/api/recovery"), {
      params: routeContext.params
    });
    expect(response.status).toBe(403);
    expect(mocks.getPayrollClaimEscrow).not.toHaveBeenCalled();
  });

  it("requires an explanatory note for the Other reason", async () => {
    const response = await POST(request({ reason: "other", note: " " }), {
      params: routeContext.params
    });
    expect(response.status).toBe(400);
    expect(mocks.recoverPayrollAllocation).not.toHaveBeenCalled();
  });

  it("requires same-origin mutation requests", async () => {
    mocks.assertSameOrigin.mockImplementationOnce(() => {
      throw new mocks.MockRequestSecurityError();
    });
    const response = await POST(request({ reason: "payroll_correction" }), {
      params: routeContext.params
    });
    expect(response.status).toBe(403);
    expect(mocks.recoverPayrollAllocation).not.toHaveBeenCalled();
  });

  it("records a successful recovery only when the service reports reconciled value movement", async () => {
    const response = await POST(request({
      reason: "payroll_correction",
      signature: "5".repeat(64),
      phase: "recovery"
    }), { params: routeContext.params });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "recovered",
      signature: "recovery-signature",
      valueTransferred: true
    });
    expect(mocks.recoverPayrollAllocation).toHaveBeenCalledWith({}, {
      workspaceId: "workspace-a",
      runId: "run-a",
      allocationId: "allocation-a",
      actorUserId: "user-a",
      reason: "payroll_correction",
      note: null,
      signature: "5".repeat(64),
      phase: "recovery"
    });
  });

  it("does not present a pending transaction as recovered", async () => {
    mocks.recoverPayrollAllocation.mockResolvedValue({
      status: "pending",
      signature: "5".repeat(64),
      phase: "recovery"
    });
    const response = await POST(request({ reason: "payroll_correction" }), {
      params: routeContext.params
    });
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toMatchObject({
      status: "pending",
      valueTransferred: false
    });
  });

  it("keeps a finalized but failed transfer out of the ledger-success response", async () => {
    mocks.recoverPayrollAllocation.mockResolvedValue({
      status: "retry_ready",
      signature: "failed-signature"
    });
    const response = await POST(request({ reason: "payroll_correction" }), {
      params: routeContext.params
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "retry_ready",
      valueTransferred: false
    });
  });

  it("maps typed recovery errors to stable safe errors", async () => {
    mocks.recoverPayrollAllocation.mockRejectedValueOnce(
      new mocks.MockPayrollConfidentialRecoveryError("payroll_allocation_not_recoverable", 409)
    );
    const response = await POST(request({ reason: "payroll_correction" }), {
      params: routeContext.params
    });
    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({
      error: "payroll_allocation_not_recoverable",
      retryable: false
    });
  });
});
