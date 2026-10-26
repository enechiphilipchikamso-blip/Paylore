import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  applyVerifiedSubscriptionPayment: vi.fn(),
  clearSessionCookie: vi.fn(),
  getDatabase: vi.fn(),
  getSessionState: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  getWorkspaceSubscription: vi.fn(),
  keepSubscriptionActive: vi.fn(),
  listSubscriptionPayments: vi.fn(),
  scheduleSubscriptionCancellation: vi.fn(),
  assertSameOrigin: vi.fn(),
  verifySubscriptionPayment: vi.fn(),
  RequestSecurityError: class extends Error {},
  PaymentVerificationError: class extends Error {
    constructor(readonly reason: string) {
      super(reason);
    }
  }
}));

vi.mock("@paylore/database", () => ({
  applyVerifiedSubscriptionPayment: mocks.applyVerifiedSubscriptionPayment,
  getWorkspaceForUser: mocks.getWorkspaceForUser,
  getWorkspaceSubscription: mocks.getWorkspaceSubscription,
  keepSubscriptionActive: mocks.keepSubscriptionActive,
  listSubscriptionPayments: mocks.listSubscriptionPayments,
  scheduleSubscriptionCancellation: mocks.scheduleSubscriptionCancellation
}));
vi.mock("../../../../../server/session", () => ({
  clearSessionCookie: mocks.clearSessionCookie,
  getSessionState: mocks.getSessionState
}));
vi.mock("../../../../../server/security", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
  RequestSecurityError: mocks.RequestSecurityError
}));
vi.mock("../../../../../server/db", () => ({
  getDatabase: mocks.getDatabase
}));
vi.mock("../../../../../server/solana/payment-verification", () => ({
  verifySubscriptionPayment: mocks.verifySubscriptionPayment,
  PaymentVerificationError: mocks.PaymentVerificationError
}));

import { GET, PATCH, POST } from "./route";

const context = { params: Promise.resolve({ workspaceId: "workspace-a" }) };
const signature = "1".repeat(64);

function writeRequest(method: "POST" | "PATCH", body: unknown) {
  return new Request("https://paylore.test/api/workspaces/workspace-a/billing", {
    method,
    headers: {
      origin: "https://paylore.test",
      "content-type": "application/json"
    },
    body: JSON.stringify(body)
  });
}

function setRole(role: "organization_admin" | "finance_auditor" | "contributor") {
  mocks.getWorkspaceForUser.mockResolvedValue({ role });
}

describe("workspace billing role/read-write matrix", () => {
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
    setRole("organization_admin");
    mocks.getWorkspaceSubscription.mockResolvedValue({ status: "archived" });
    mocks.listSubscriptionPayments.mockResolvedValue([
      { signature, amountBaseUnits: "49000000" }
    ]);
    mocks.verifySubscriptionPayment.mockResolvedValue({
      signature,
      amountBaseUnits: "49000000",
      mint: "usdc-mint",
      recipient: "subscription-recipient"
    });
    mocks.applyVerifiedSubscriptionPayment.mockResolvedValue({
      duplicate: false,
      periodEnd: new Date("2026-11-25T00:00:00.000Z")
    });
    mocks.scheduleSubscriptionCancellation.mockResolvedValue({
      status: "cancel_scheduled"
    });
    mocks.keepSubscriptionActive.mockResolvedValue({
      status: "active"
    });
    mocks.assertSameOrigin.mockImplementation(() => undefined);
  });

  const roles = [
    { role: "organization_admin" as const, readStatus: 200, writeStatus: 200 },
    { role: "finance_auditor" as const, readStatus: 200, writeStatus: 403 },
    { role: "contributor" as const, readStatus: 403, writeStatus: 403 }
  ];

  for (const entry of roles) {
    it(`allows ${entry.role} billing access only at its approved read/write level`, async () => {
      setRole(entry.role);

      const read = await GET(
        new Request("https://paylore.test/api/workspaces/workspace-a/billing"),
        context
      );
      expect(read.status).toBe(entry.readStatus);
      if (entry.readStatus === 200) {
        await expect(read.json()).resolves.toMatchObject({
          subscription: { status: "archived" },
          payments: [{ signature }],
          canManage: entry.role === "organization_admin"
        });
        expect(mocks.getWorkspaceSubscription).toHaveBeenCalledWith({}, "workspace-a");
        expect(mocks.listSubscriptionPayments).toHaveBeenCalledWith({}, "workspace-a");
      } else {
        await expect(read.json()).resolves.toEqual({ error: "workspace_access_denied" });
        expect(mocks.getWorkspaceSubscription).not.toHaveBeenCalled();
        expect(mocks.listSubscriptionPayments).not.toHaveBeenCalled();
      }

      const paymentWrite = await POST(
        writeRequest("POST", { signature }),
        context
      );
      expect(paymentWrite.status).toBe(entry.writeStatus);

      const cancelWrite = await PATCH(
        writeRequest("PATCH", { action: "cancel" }),
        context
      );
      expect(cancelWrite.status).toBe(entry.writeStatus);

      const resumeWrite = await PATCH(
        writeRequest("PATCH", { action: "keep-active" }),
        context
      );
      expect(resumeWrite.status).toBe(entry.writeStatus);

      if (entry.role === "organization_admin") {
        expect(mocks.verifySubscriptionPayment).toHaveBeenCalledTimes(1);
        expect(mocks.applyVerifiedSubscriptionPayment).toHaveBeenCalledTimes(1);
        expect(mocks.scheduleSubscriptionCancellation).toHaveBeenCalledTimes(1);
        expect(mocks.keepSubscriptionActive).toHaveBeenCalledTimes(1);
      } else {
        expect(mocks.verifySubscriptionPayment).not.toHaveBeenCalled();
        expect(mocks.applyVerifiedSubscriptionPayment).not.toHaveBeenCalled();
        expect(mocks.scheduleSubscriptionCancellation).not.toHaveBeenCalled();
        expect(mocks.keepSubscriptionActive).not.toHaveBeenCalled();
      }
    });
  }

  it("requires a signed-in workspace member before exposing billing history", async () => {
    mocks.getSessionState.mockResolvedValue({ status: "unauthenticated" });
    const unauthenticated = await GET(
      new Request("https://paylore.test/api/workspaces/workspace-a/billing"),
      context
    );
    expect(unauthenticated.status).toBe(401);
    expect(mocks.clearSessionCookie).toHaveBeenCalledOnce();

    mocks.getSessionState.mockResolvedValue({
      status: "authenticated",
      session: { userId: "user-a", walletAddress: "wallet-a" }
    });
    mocks.getWorkspaceForUser.mockResolvedValue(null);
    const nonMember = await GET(
      new Request("https://paylore.test/api/workspaces/workspace-a/billing"),
      context
    );
    expect(nonMember.status).toBe(403);
    expect(mocks.getWorkspaceSubscription).not.toHaveBeenCalled();
  });
});
