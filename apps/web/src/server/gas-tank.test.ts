import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createWorkspaceLedgerEntry: vi.fn(),
  createWorkspaceNotificationForFinanceMembers: vi.fn(),
  getWorkspaceGasTank: vi.fn(),
  updateWorkspaceGasTankBalance: vi.fn(),
  readSolanaRpc: vi.fn()
}));

vi.mock("@paylore/database", () => mocks);
vi.mock("./config", () => ({
  loadPayloreConfig: () => ({})
}));
vi.mock("./solana/rpc", () => ({
  readSolanaRpc: mocks.readSolanaRpc
}));
vi.mock("server-only", () => ({}));

import { verifyWorkspaceGasTankFunding } from "./gas-tank";

const gasTank = {
  address: "gas-tank-address",
  balanceLamports: "50",
  lastActivityAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-01T00:00:00.000Z")
};

function fundingTransaction() {
  return {
    meta: { err: null },
    transaction: {
      message: {
        accountKeys: [{ pubkey: "payer-address", signer: true }],
        instructions: [{
          program: "system",
          parsed: {
            type: "transfer",
            info: {
              source: "payer-address",
              destination: gasTank.address,
              lamports: "100"
            }
          }
        }]
      }
    }
  };
}

describe("Gas Tank funding balance reconciliation", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.getWorkspaceGasTank.mockResolvedValue(gasTank);
    mocks.createWorkspaceLedgerEntry.mockResolvedValue({
      entry: {},
      created: true
    });
    mocks.createWorkspaceNotificationForFinanceMembers.mockResolvedValue(
      undefined
    );
    mocks.updateWorkspaceGasTankBalance.mockImplementation(
      async (_db, _workspaceId, balanceLamports) => ({
        ...gasTank,
        balanceLamports
      })
    );
    mocks.readSolanaRpc.mockImplementation(async (method: string) => {
      if (method === "getTransaction") return fundingTransaction();
      if (method === "getSignatureStatuses") {
        return {
          value: [{ confirmationStatus: "finalized", err: null }]
        };
      }
      if (method === "getBalance") return { value: 150 };
      throw new Error(`Unexpected RPC method: ${method}`);
    });
  });

  it("persists the live post-funding balance rather than the stale pre-funding snapshot", async () => {
    const result = await verifyWorkspaceGasTankFunding({} as never, {
      workspaceId: "workspace-1",
      payer: "payer-address",
      signature: "5".repeat(64),
      expectedLamports: "100"
    });

    expect(result).toEqual({
      status: "finalized",
      duplicate: false,
      balanceLamports: "150"
    });
    expect(mocks.updateWorkspaceGasTankBalance).toHaveBeenCalledWith(
      {},
      "workspace-1",
      "150"
    );
  });
});
