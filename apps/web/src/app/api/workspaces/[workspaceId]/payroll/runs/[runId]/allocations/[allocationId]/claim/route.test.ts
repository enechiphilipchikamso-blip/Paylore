import { beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({
  assertSameOrigin: vi.fn(), clearSessionCookie: vi.fn(), getDatabase: vi.fn(), getSessionState: vi.fn(),
  getWorkspaceForUser: vi.fn(), findWorkspaceContributorByWallet: vi.fn(), getWorkspacePayrollRun: vi.fn(),
  settleContributorPayrollAllocation: vi.fn()
}));
vi.mock("@paylore/database", () => ({
  getWorkspaceForUser: mocks.getWorkspaceForUser,
  findWorkspaceContributorByWallet: mocks.findWorkspaceContributorByWallet,
  getWorkspacePayrollRun: mocks.getWorkspacePayrollRun
}));
vi.mock("../../../../../../../../../../server/db", () => ({ getDatabase: mocks.getDatabase }));
vi.mock("../../../../../../../../../../server/session", () => ({
  clearSessionCookie: mocks.clearSessionCookie, getSessionState: mocks.getSessionState
}));
vi.mock("../../../../../../../../../../server/security", () => ({
  assertSameOrigin: mocks.assertSameOrigin, RequestSecurityError: class RequestSecurityError extends Error {}
}));
vi.mock("../../../../../../../../../../server/solana/payroll-confidential-settlement", () => ({
  PayrollConfidentialSettlementError: class PayrollConfidentialSettlementError extends Error {
    constructor(readonly code: string, readonly statusCode: number) { super(code); }
  },
  settleContributorPayrollAllocation: mocks.settleContributorPayrollAllocation
}));
import { POST } from "./route";
const context = { params: Promise.resolve({ workspaceId: "workspace-a", runId: "run-a", allocationId: "allocation-a" }) };
const allocation = { id: "allocation-a", contributorId: "contributor-a", contributorWalletAddress: "contributor-wallet" };
const request = () => new Request("https://paylore.test/api/claim", { method: "POST", headers: { origin: "https://paylore.test" } });
describe("confidential payroll claim route", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.assertSameOrigin.mockImplementation(() => undefined);
    mocks.getDatabase.mockReturnValue({});
    mocks.getSessionState.mockResolvedValue({ status: "authenticated", session: { userId: "user-a", walletAddress: "contributor-wallet" } });
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "contributor" });
    mocks.findWorkspaceContributorByWallet.mockResolvedValue({ id: "contributor-a", lifecycle: "active" });
    mocks.getWorkspacePayrollRun.mockResolvedValue({ allocations: [allocation] });
    mocks.settleContributorPayrollAllocation.mockResolvedValue({ status: "claimed", signature: "settlement-signature", amountBaseUnits: "1000000", proofDurationMs: 17.2 });
  });
  it("scopes by session wallet and returns non-sensitive proof timing", async () => {
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ status: "claimed", amountBaseUnits: "1000000" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("server-timing")).toContain("confidential-proof;dur=17.20");
    expect(mocks.settleContributorPayrollAllocation).toHaveBeenCalledWith({}, {
      workspaceId: "workspace-a", runId: "run-a", allocationId: "allocation-a",
      contributorId: "contributor-a", contributorAddress: "contributor-wallet", contributorUserId: "user-a"
    });
  });
  it("rejects an allocation belonging to another wallet", async () => {
    mocks.getWorkspacePayrollRun.mockResolvedValue({ allocations: [{ ...allocation, contributorWalletAddress: "different-wallet" }] });
    const response = await POST(request(), context);
    expect(response.status).toBe(404);
    expect(mocks.settleContributorPayrollAllocation).not.toHaveBeenCalled();
  });
  it("rejects non-contributor roles", async () => {
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "organization_admin" });
    const response = await POST(request(), context);
    expect(response.status).toBe(403);
    expect(mocks.settleContributorPayrollAllocation).not.toHaveBeenCalled();
  });
  it("handles anonymous sessions and missing wallet identity", async () => {
    mocks.getSessionState.mockResolvedValue({ status: "anonymous" });
    expect((await POST(request(), context)).status).toBe(401);
    expect(mocks.clearSessionCookie).toHaveBeenCalledOnce();
    mocks.getSessionState.mockResolvedValue({ status: "authenticated", session: { userId: "user-a", walletAddress: null } });
    expect((await POST(request(), context)).status).toBe(403);
  });
});
