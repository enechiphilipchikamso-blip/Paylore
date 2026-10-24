import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  db: {},
  tokenProgramOwner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  recipient: "Vote111111111111111111111111111111111111111",
  getSessionState: vi.fn(),
  clearSessionCookie: vi.fn(),
  assertSameOrigin: vi.fn(),
  isValidSolanaAddress: vi.fn(),
  getDatabase: vi.fn(),
  getWorkspaceForUser: vi.fn(),
  createSubscriptionPaymentAttempt: vi.fn(),
  loadPayloreConfig: vi.fn(),
  readSolanaRpc: vi.fn()
}));

vi.mock("@solana-program/token-2022", () => ({
  TOKEN_2022_PROGRAM_ADDRESS: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
}));
vi.mock("@paylore/database", () => ({
  createSubscriptionPaymentAttempt: mocks.createSubscriptionPaymentAttempt,
  getWorkspaceForUser: mocks.getWorkspaceForUser
}));
vi.mock("../../../../../../server/db", () => ({
  getDatabase: mocks.getDatabase
}));
vi.mock("../../../../../../server/config", () => ({
  loadPayloreConfig: mocks.loadPayloreConfig
}));
vi.mock("../../../../../../server/security", () => ({
  assertSameOrigin: mocks.assertSameOrigin,
  isValidSolanaAddress: mocks.isValidSolanaAddress,
  RequestSecurityError: class RequestSecurityError extends Error {}
}));
vi.mock("../../../../../../server/session", () => ({
  getSessionState: mocks.getSessionState,
  clearSessionCookie: mocks.clearSessionCookie
}));
vi.mock("../../../../../../server/solana/rpc", () => ({
  readSolanaRpc: mocks.readSolanaRpc,
  SolanaRpcError: class SolanaRpcError extends Error {}
}));

import { POST } from "./route";

const WORKSPACE_ID = "workspace-a";
const USER_ID = "admin-user";
const PAYER = "11111111111111111111111111111111";
const BLOCKHASH = "11111111111111111111111111111111";
const CLASSIC_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

function request() {
  return new Request("https://paylore.test/api/workspaces/workspace-a/billing/prepare", {
    method: "POST",
    headers: { origin: "https://paylore.test", "content-type": "application/json" },
    body: "{}"
  });
}
const context = { params: Promise.resolve({ workspaceId: WORKSPACE_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getSessionState.mockResolvedValue({
    status: "authenticated",
    session: { userId: USER_ID, walletAddress: PAYER }
  });
  mocks.clearSessionCookie.mockResolvedValue(undefined);
  mocks.assertSameOrigin.mockImplementation(() => undefined);
  mocks.isValidSolanaAddress.mockImplementation((value: string) =>
    [PAYER, mocks.recipient, mocks.mint].includes(value)
  );
  mocks.getDatabase.mockReturnValue(mocks.db);
  mocks.getWorkspaceForUser.mockResolvedValue({ role: "organization_admin" });
  mocks.createSubscriptionPaymentAttempt.mockResolvedValue({ id: "unused" });
  mocks.loadPayloreConfig.mockReturnValue({
    PAYLORE_SUBSCRIPTION_RECIPIENT: mocks.recipient,
    PAYLORE_SUBSCRIPTION_USDC_MINT: mocks.mint
  });
  mocks.readSolanaRpc.mockImplementation(async (method: string) => {
    if (method === "getLatestBlockhash") {
      return { context: { slot: 100 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 250 } };
    }
    if (method === "getAccountInfo") return { value: { owner: CLASSIC_TOKEN_PROGRAM } };
    throw new Error("Unexpected RPC method.");
  });
});

describe("subscription payment preparation route", () => {
  it("returns a prepared Devnet payment bound to the configured mint owner and persists its unique attempt", async () => {
    const response = await POST(request(), context);
    expect(response.status).toBe(200);
    const result = await response.json();

    expect(result).toMatchObject({
      payer: PAYER,
      recipient: mocks.recipient,
      mint: mocks.mint,
      tokenProgram: CLASSIC_TOKEN_PROGRAM,
      blockhash: BLOCKHASH,
      lastValidBlockHeight: 250
    });
    expect(result.attemptId).toEqual(expect.any(String));
    expect(result.memo).toBe(`Paylore activation attempt ${result.attemptId} | workspace ${WORKSPACE_ID}`);
    expect(Date.parse(result.expiresAt)).toBeGreaterThan(Date.now());
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(mocks.createSubscriptionPaymentAttempt).toHaveBeenCalledWith(
      mocks.db,
      expect.objectContaining({
        id: result.attemptId,
        workspaceId: WORKSPACE_ID,
        userId: USER_ID,
        payerWalletAddress: PAYER,
        recipient: mocks.recipient,
        mint: mocks.mint,
        amountBaseUnits: "49000000",
        blockhash: BLOCKHASH,
        lastValidBlockHeight: 250
      })
    );
  });

  it("does not prepare a wallet payment for non-administrators", async () => {
    mocks.getWorkspaceForUser.mockResolvedValueOnce({ role: "finance_auditor" });

    const response = await POST(request(), context);

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "workspace_access_denied" });
    expect(mocks.readSolanaRpc).not.toHaveBeenCalled();
    expect(mocks.createSubscriptionPaymentAttempt).not.toHaveBeenCalled();
  });

  it("does not prepare a transfer when the configured mint is not owned by a supported token program", async () => {
    mocks.readSolanaRpc.mockImplementation(async (method: string) => {
      if (method === "getLatestBlockhash") {
        return { context: { slot: 100 }, value: { blockhash: BLOCKHASH, lastValidBlockHeight: 250 } };
      }
      if (method === "getAccountInfo") return { value: { owner: "11111111111111111111111111111111" } };
      throw new Error("Unexpected RPC method.");
    });

    const response = await POST(request(), context);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "payment_configuration_incomplete" });
    expect(mocks.createSubscriptionPaymentAttempt).not.toHaveBeenCalled();
  });

  it("does not prepare a payment when the mint or recipient configuration is invalid", async () => {
    mocks.loadPayloreConfig.mockReturnValueOnce({
      PAYLORE_SUBSCRIPTION_RECIPIENT: "",
      PAYLORE_SUBSCRIPTION_USDC_MINT: mocks.mint
    });

    const response = await POST(request(), context);

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ error: "payment_configuration_incomplete" });
    expect(mocks.readSolanaRpc).not.toHaveBeenCalled();
    expect(mocks.createSubscriptionPaymentAttempt).not.toHaveBeenCalled();
  });
});
