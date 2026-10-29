import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  gasTankSnapshot: vi.fn(),
  reserveSnapshot: vi.fn()
}));

vi.mock("./gas-tank", () => ({
  getWorkspaceGasTankSnapshot: mocks.gasTankSnapshot
}));

vi.mock("./solana/workspace-reserve", () => ({
  getWorkspaceConfidentialReserveSnapshot: mocks.reserveSnapshot
}));

import { getWorkspaceSetupProgress } from "./workspace-setup-progress";

describe("workspace setup progress", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.gasTankSnapshot.mockResolvedValue({
      address: "gas-tank-address",
      balanceLamports: "100000000",
      lowBalance: false
    });
    mocks.reserveSnapshot.mockResolvedValue({
      status: "program_configured",
      programReserveConfigured: true,
      confidentialTransferReady: true
    });
  });

  it("marks setup complete only when live Gas Tank and Reserve checks are ready", async () => {
    await expect(getWorkspaceSetupProgress({} as never, "workspace-a", "wallet-a"))
      .resolves.toEqual({
        gasTank: {
          status: "ready",
          address: "gas-tank-address",
          balanceSol: "0.1"
        },
        reserve: { status: "ready" },
        complete: true
      });
  });

  it("requires Gas Tank initialization before Reserve setup", async () => {
    mocks.gasTankSnapshot.mockResolvedValue(null);
    mocks.reserveSnapshot.mockResolvedValue({ status: "no_reserve" });

    await expect(getWorkspaceSetupProgress({} as never, "workspace-a", "wallet-a"))
      .resolves.toMatchObject({
        gasTank: { status: "not_initialized", address: null, balanceSol: null },
        reserve: { status: "key_custody_required" },
        complete: false
      });
  });

  it("marks a low live Gas Tank balance as needing funding even when the Reserve is ready", async () => {
    mocks.gasTankSnapshot.mockResolvedValue({
      address: "gas-tank-address",
      balanceLamports: "1000",
      lowBalance: true
    });

    await expect(getWorkspaceSetupProgress({} as never, "workspace-a", "wallet-a"))
      .resolves.toMatchObject({
        gasTank: { status: "funding_required", balanceSol: "0.000001" },
        reserve: { status: "ready" },
        complete: false
      });
  });

  it("does not call an unavailable Gas Tank balance ready", async () => {
    mocks.gasTankSnapshot.mockRejectedValue(new Error("RPC unavailable"));

    await expect(getWorkspaceSetupProgress({} as never, "workspace-a", "wallet-a"))
      .resolves.toMatchObject({
        gasTank: { status: "balance_unavailable", address: null, balanceSol: null },
        reserve: { status: "ready" },
        complete: false
      });
  });

  it("does not mark an invalid lamport balance as ready", async () => {
    mocks.gasTankSnapshot.mockResolvedValue({
      address: "gas-tank-address",
      balanceLamports: "not-a-number",
      lowBalance: false
    });

    await expect(getWorkspaceSetupProgress({} as never, "workspace-a", "wallet-a"))
      .resolves.toMatchObject({
        gasTank: {
          status: "balance_unavailable",
          address: "gas-tank-address",
          balanceSol: null
        },
        complete: false
      });
  });

  it("distinguishes an absent Payroll workspace account from a reserve needing setup", async () => {
    mocks.reserveSnapshot.mockResolvedValue({
      status: "workspace_program_not_initialized",
      confidentialTransferReady: false,
      programReserveConfigured: false
    });

    await expect(getWorkspaceSetupProgress({} as never, "workspace-a", "wallet-a"))
      .resolves.toMatchObject({
        reserve: { status: "workspace_program_not_initialized" },
        complete: false
      });
  });

  it("keeps Reserve status unavailable when reconciliation fails", async () => {
    mocks.reserveSnapshot.mockRejectedValue(new Error("RPC unavailable"));

    await expect(getWorkspaceSetupProgress({} as never, "workspace-a", "wallet-a"))
      .resolves.toMatchObject({
        reserve: { status: "unavailable" },
        complete: false
      });
  });
});
