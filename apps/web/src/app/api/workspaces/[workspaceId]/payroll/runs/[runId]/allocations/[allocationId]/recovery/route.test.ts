import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  class MockRequestSecurityError extends Error {}

  return {
    MockRequestSecurityError,
    assertSameOrigin: vi.fn(),
    clearSessionCookie: vi.fn(),
    getDatabase: vi.fn(),
    getSessionState: vi.fn(),
    getWorkspaceForUser: vi.fn(),
    getWorkspacePayrollRun: vi.fn(),
    recordPayrollRecovery: vi.fn(),
    verifyPayrollRecoveryTransaction: vi.fn()
  };
});

vi.mock("@paylore/database", () => ({
  getWorkspaceForUser: mocks.getWorkspaceForUser,
  getWorkspacePayrollRun: mocks.getWorkspacePayrollRun,
  recordPayrollRecovery: mocks.recordPayrollRecovery
}));

vi.mock("../../../../../../../../../../server/session", () => ({
  clearSessionCookie: mocks.clearSessionCookie,
  getSessionState: mocks.getSessionState
}));

vi.mock("../../../../../../../../../../server/db", () => ({
  getDatabase: mocks.getDatabase
}));

vi.mock("../../../../../../../../../../server/solana/payroll-program-verification", () => ({
  verifyPayrollRecoveryTransaction: mocks.verifyPayrollRecoveryTransaction
}));

vi.mock("../../../../../../../../../../server/security", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
  RequestSecurityError: mocks.MockRequestSecurityError
}));

import { POST } from "./route";

const routeContext = {
  params: Promise.resolve({
    workspaceId: "workspace-a",
    runId: "run-a",
    allocationId: "allocation-a"
  })
};

describe("payroll recovery route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDatabase.mockReturnValue({});
    mocks.getSessionState.mockResolvedValue({
      status: "authenticated",
      session: {
        userId: "user-a",
        walletAddress: "wallet-a"
      }
    });
    mocks.getWorkspaceForUser.mockResolvedValue({
      role: "organization_admin"
    });
    mocks.getWorkspacePayrollRun.mockResolvedValue({
      run: { allocationCommitment: "ab".repeat(32) },
      allocations: [{
        id: "allocation-a",
        claimId: "01".repeat(32),
        claimAddress: "claim-address",
        contributorWalletAddress: "contributor-wallet",
        status: "unclaimed"
      }]
    });
    mocks.recordPayrollRecovery.mockResolvedValue({ status: "recovered" });
  });

  it("requires a finalized on-chain recovery before recording it", async () => {
    mocks.verifyPayrollRecoveryTransaction.mockRejectedValueOnce(
      new Error("The finalized Claim PDA is not in the expected RECOVERED state.")
    );
    const response = await POST(
      new Request("https://paylore.test/api/recovery", {
        method: "POST",
        headers: { origin: "https://paylore.test", "content-type": "application/json" },
        body: JSON.stringify({
          signature: "5".repeat(64),
          reason: "payroll_correction"
        })
      }),
      { params: Promise.resolve({
        workspaceId: "workspace-a",
        runId: "run-a",
        allocationId: "allocation-a"
      }) }
    );

    expect(response.status).toBe(503);
    expect(mocks.verifyPayrollRecoveryTransaction).toHaveBeenCalledOnce();
    expect(mocks.recordPayrollRecovery).not.toHaveBeenCalled();
  });

  it("records recovery only after the finalized PDA verifier succeeds", async () => {
    mocks.verifyPayrollRecoveryTransaction.mockResolvedValue(undefined);
    const response = await POST(
      new Request("https://paylore.test/api/recovery", {
        method: "POST",
        headers: { origin: "https://paylore.test", "content-type": "application/json" },
        body: JSON.stringify({
          signature: "5".repeat(64),
          reason: "payroll_correction"
        })
      }),
      { params: Promise.resolve({
        workspaceId: "workspace-a",
        runId: "run-a",
        allocationId: "allocation-a"
      }) }
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "recovered",
      valueTransferred: false
    });
    expect(mocks.recordPayrollRecovery).toHaveBeenCalledOnce();
  });

  it("requires authentication before reaching recovery handling", async () => {
    mocks.getSessionState.mockResolvedValue({ status: "anonymous" });

    const response = await POST(
      new Request("https://paylore.test/api/recovery", { method: "POST" }),
      routeContext
    );

    expect(response.status).toBe(401);
    expect(mocks.clearSessionCookie).toHaveBeenCalledOnce();
    expect(mocks.getWorkspaceForUser).not.toHaveBeenCalled();
  });

  it("rejects non-admin workspace members", async () => {
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "finance_auditor" });

    const response = await POST(
      new Request("https://paylore.test/api/recovery", { method: "POST" }),
      routeContext
    );

    expect(response.status).toBe(403);
  });

  it.each(["claimed", "settlement_pending", "recovered", "cancelled"] as const)(
    "rejects a %s allocation before accepting a recovery transaction",
    async (status) => {
      mocks.getWorkspacePayrollRun.mockResolvedValue({
        run: { allocationCommitment: "ab".repeat(32) },
        allocations: [{
          id: "allocation-a",
          claimId: "01".repeat(32),
          claimAddress: "claim-address",
          contributorWalletAddress: "contributor-wallet",
          status
        }]
      });

      const response = await POST(
        new Request("https://paylore.test/api/recovery", {
          method: "POST",
          headers: { origin: "https://paylore.test", "content-type": "application/json" },
          body: JSON.stringify({
            signature: "5".repeat(64),
            reason: "payroll_correction"
          })
        }),
        routeContext
      );

      expect(response.status).toBe(409);
      expect(mocks.verifyPayrollRecoveryTransaction).not.toHaveBeenCalled();
      expect(mocks.recordPayrollRecovery).not.toHaveBeenCalled();
    }
  );

  it("does not reconcile a competing claim when the finalized on-chain recovery check loses the race", async () => {
    mocks.verifyPayrollRecoveryTransaction.mockRejectedValueOnce(
      new Error("The finalized Claim PDA is not in the expected RECOVERED state.")
    );

    const response = await POST(
      new Request("https://paylore.test/api/recovery", {
        method: "POST",
        headers: { origin: "https://paylore.test", "content-type": "application/json" },
        body: JSON.stringify({
          signature: "5".repeat(64),
          reason: "payroll_correction"
        })
      }),
      routeContext
    );

    expect(response.status).toBe(503);
    expect(mocks.recordPayrollRecovery).not.toHaveBeenCalled();
  });
});
