import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  assertSameOrigin: vi.fn(),
  clearSessionCookie: vi.fn(),
  getDatabase: vi.fn(),
  getSessionState: vi.fn(),
  getWorkspaceDeletionState: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  getWorkspaceSubscription: vi.fn(),
  getWorkspaceGasTankSnapshot: vi.fn(),
  initializeWorkspaceGasTank: vi.fn(),
  verifyAndRestoreWorkspaceGasTank: vi.fn(),
  verifyWorkspaceGasTankFunding: vi.fn(),
  readSolanaRpc: vi.fn()
}));

vi.mock("@paylore/database", () => ({
  getWorkspaceDeletionState: mocks.getWorkspaceDeletionState,
  getWorkspaceForUser: mocks.getWorkspaceForUser,
  getWorkspaceSubscription: mocks.getWorkspaceSubscription
}));
vi.mock("../../../../../server/session", () => ({
  clearSessionCookie: mocks.clearSessionCookie,
  getSessionState: mocks.getSessionState
}));
vi.mock("../../../../../server/security", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
  RequestSecurityError: class RequestSecurityError extends Error {}
}));
vi.mock("../../../../../server/db", () => ({ getDatabase: mocks.getDatabase }));
vi.mock("../../../../../server/gas-tank", () => ({
  getWorkspaceGasTankSnapshot: mocks.getWorkspaceGasTankSnapshot,
  initializeWorkspaceGasTank: mocks.initializeWorkspaceGasTank,
  verifyAndRestoreWorkspaceGasTank: mocks.verifyAndRestoreWorkspaceGasTank,
  verifyWorkspaceGasTankFunding: mocks.verifyWorkspaceGasTankFunding
}));
vi.mock("../../../../../server/solana/rpc", () => ({ readSolanaRpc: mocks.readSolanaRpc }));

import { GET, POST } from "./route";

const context = { params: Promise.resolve({ workspaceId: "workspace-a" }) };

function request(body: unknown) {
  return new Request("https://paylore.test/api/workspaces/workspace-a/gas-tank", {
    method: "POST",
    headers: { origin: "https://paylore.test", "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

describe("workspace Gas Tank API", () => {
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
    mocks.getWorkspaceGasTankSnapshot.mockResolvedValue({
      address: "gas-tank-address",
      balanceLamports: "50000000",
      lowBalance: false,
      lastActivityAt: "2026-10-20T00:00:00.000Z",
      updatedAt: "2026-10-20T00:00:00.000Z",
      encryptedPrivateKey: "do-not-return",
      envelopeKey: "do-not-return",
      operationData: { transactionBase64: "do-not-return" }
    });
    mocks.initializeWorkspaceGasTank.mockResolvedValue({
      address: "gas-tank-address",
      created: true,
      encryptedPrivateKey: "do-not-return",
      privateKey: "do-not-return"
    });
    mocks.verifyAndRestoreWorkspaceGasTank.mockResolvedValue({
      address: "gas-tank-address",
      restoredAt: new Date("2026-10-20T00:00:00.000Z"),
      encryptedPrivateKey: "do-not-return"
    });
    mocks.readSolanaRpc.mockResolvedValue({
      value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 123 }
    });
  });

  it("returns only the public status projection, never key or operation payloads", async () => {
    const response = await GET(new Request("https://paylore.test/api/workspaces/workspace-a/gas-tank"), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.gasTank).toMatchObject({
      address: "gas-tank-address",
      balanceLamports: "50000000",
      lowBalance: false
    });
    expect(JSON.stringify(body)).not.toContain("do-not-return");
    expect(Object.keys(body.gasTank).sort()).toEqual([
      "address", "balanceLamports", "lastActivityAt", "lowBalance", "updatedAt"
    ]);
  });

  it("keeps initialization and backup responses on a public-only DTO", async () => {
    const initialize = await POST(request({ action: "initialize" }), context);
    expect(initialize.status).toBe(200);
    const initializeBody = await initialize.json();
    expect(initializeBody).toEqual({ status: "ready", address: "gas-tank-address", created: true });
    expect(JSON.stringify(initializeBody)).not.toContain("do-not-return");

    const restore = await POST(request({ action: "restore" }), context);
    expect(restore.status).toBe(200);
    const restoreBody = await restore.json();
    expect(restoreBody).toMatchObject({ status: "ready", address: "gas-tank-address" });
    expect(JSON.stringify(restoreBody)).not.toContain("do-not-return");
  });

  it("denies mutation from finance members and contributors", async () => {
    mocks.getWorkspaceForUser.mockResolvedValue({ role: "finance_auditor" });
    const finance = await POST(request({ action: "initialize" }), context);
    expect(finance.status).toBe(403);
    expect(mocks.initializeWorkspaceGasTank).not.toHaveBeenCalled();

    mocks.getWorkspaceForUser.mockResolvedValue({ role: "contributor" });
    const contributor = await GET(new Request("https://paylore.test/api/workspaces/workspace-a/gas-tank"), context);
    expect(contributor.status).toBe(403);
  });

  it("rejects an unauthenticated reader without exposing state", async () => {
    mocks.getSessionState.mockResolvedValue({ status: "anonymous" });
    const response = await GET(new Request("https://paylore.test/api/workspaces/workspace-a/gas-tank"), context);
    expect(response.status).toBe(401);
    const text = await response.text();
    expect(text).not.toContain("gas-tank-address");
    expect(text).not.toContain("privateKey");
  });

  it("returns only transaction preparation details needed by the manager wallet", async () => {
    const response = await POST(request({ action: "prepare_funding", lamports: "50000000" }), context);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({
      payer: "manager-wallet",
      destination: "gas-tank-address",
      lamports: "50000000",
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 123
    });
    expect(JSON.stringify(body)).not.toContain("do-not-return");
  });
});
