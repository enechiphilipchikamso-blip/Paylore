import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getWorkspaceForUser: vi.fn(),
  getSessionState: vi.fn(),
  clearSessionCookie: vi.fn(),
  getDatabase: vi.fn(),
  assertSameOrigin: vi.fn(),
  fundUnclaimedPayrollClaimEscrow: vi.fn()
}));

vi.mock("@paylore/database", () => ({
  getWorkspaceForUser: mocks.getWorkspaceForUser
}));
vi.mock("../../../../../../../../../../server/session", () => ({
  getSessionState: mocks.getSessionState,
  clearSessionCookie: mocks.clearSessionCookie
}));
vi.mock("../../../../../../../../../../server/db", () => ({
  getDatabase: mocks.getDatabase
}));
vi.mock("../../../../../../../../../../server/security", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
  RequestSecurityError: class RequestSecurityError extends Error {}
}));
vi.mock("../../../../../../../../../../server/solana/payroll-confidential-settlement", () => ({
  fundUnclaimedPayrollClaimEscrow: mocks.fundUnclaimedPayrollClaimEscrow,
  PayrollConfidentialSettlementError: class PayrollConfidentialSettlementError extends Error {
    constructor(readonly code: string, readonly statusCode: number) {
      super(code);
    }
  }
}));

import { POST } from "./route";

const params = Promise.resolve({
  workspaceId: "workspace-a",
  runId: "run-a",
  allocationId: "allocation-a"
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getDatabase.mockReturnValue({ tag: "db" });
  mocks.getSessionState.mockResolvedValue({
    status: "authenticated",
    session: { userId: "admin-a" }
  });
  mocks.getWorkspaceForUser.mockResolvedValue({ role: "organization_admin" });
  mocks.fundUnclaimedPayrollClaimEscrow.mockResolvedValue({
    status: "funded",
    signature: "funding-signature"
  });
});

describe("payroll claim escrow funding route", () => {
  it("allows an organization admin and returns the verified funding result", async () => {
    const response = await POST(new Request("https://paylore.test"), { params });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      status: "funded",
      signature: "funding-signature"
    });
    expect(mocks.fundUnclaimedPayrollClaimEscrow).toHaveBeenCalledWith(
      { tag: "db" },
      { workspaceId: "workspace-a", runId: "run-a", allocationId: "allocation-a" }
    );
  });

  it("returns the stage a pending funding is waiting at and logs it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.fundUnclaimedPayrollClaimEscrow.mockResolvedValue({
      status: "pending",
      signature: "funding-signature",
      stage: "proof_setup_unconfirmed"
    });

    const response = await POST(new Request("https://paylore.test"), { params });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      status: "pending",
      signature: "funding-signature",
      stage: "proof_setup_unconfirmed"
    });
    expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
      event: "payroll_claim_escrow_funding_not_funded",
      errorCode: "pending",
      workspaceId: "workspace-a",
      allocationId: "allocation-a",
      stage: "proof_setup_unconfirmed"
    });
    warn.mockRestore();
  });

  it("logs and returns a retry-ready result so the action can be run again", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    mocks.fundUnclaimedPayrollClaimEscrow.mockResolvedValue({ status: "retry_ready" });

    const response = await POST(new Request("https://paylore.test"), { params });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ status: "retry_ready" });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("does not log a clean funded result as a problem", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    await POST(new Request("https://paylore.test"), { params });

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("does not allow contributors to fund an organization claim escrow", async () => {
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "contributor" });

    const response = await POST(new Request("https://paylore.test"), { params });

    expect(response.status).toBe(403);
    expect(mocks.fundUnclaimedPayrollClaimEscrow).not.toHaveBeenCalled();
  });
});
