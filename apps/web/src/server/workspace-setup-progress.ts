import "server-only";

import type { Database } from "@paylore/database";
import { getWorkspaceGasTankSnapshot } from "./gas-tank";
import { getWorkspaceConfidentialReserveSnapshot } from "./solana/workspace-reserve";

export type GasTankSetupStatus =
  | "not_initialized"
  | "funding_required"
  | "ready"
  | "balance_unavailable";

export type ReserveSetupStatus =
  | "key_custody_required"
  | "workspace_program_not_initialized"
  | "setup_required"
  | "ready"
  | "unavailable";

export type WorkspaceSetupProgress = {
  gasTank: {
    status: GasTankSetupStatus;
    address: string | null;
    balanceSol: string | null;
  };
  reserve: {
    status: ReserveSetupStatus;
  };
  complete: boolean;
};

function formatSol(lamports: string): string | null {
  try {
    const value = BigInt(lamports);
    if (value < 0n) return null;
    const whole = value / 1_000_000_000n;
    const fraction = (value % 1_000_000_000n)
      .toString()
      .padStart(9, "0")
      .replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : whole.toString();
  } catch {
    return null;
  }
}

/** Reads live setup signals without turning provider failures into a false ready state. */
export async function getWorkspaceSetupProgress(
  db: Database,
  workspaceId: string,
  walletAddress: string
): Promise<WorkspaceSetupProgress> {
  const [gasTankResult, reserveResult] = await Promise.allSettled([
    getWorkspaceGasTankSnapshot(db, workspaceId),
    getWorkspaceConfidentialReserveSnapshot(db, workspaceId, walletAddress)
  ]);

  let gasTank: WorkspaceSetupProgress["gasTank"];
  if (gasTankResult.status === "rejected") {
    gasTank = {
      status: "balance_unavailable",
      address: null,
      balanceSol: null
    };
  } else if (!gasTankResult.value) {
    gasTank = {
      status: "not_initialized",
      address: null,
      balanceSol: null
    };
  } else {
    const snapshot = gasTankResult.value;
    const balanceSol = formatSol(snapshot.balanceLamports);
    gasTank = balanceSol === null
      ? {
          status: "balance_unavailable",
          address: snapshot.address,
          balanceSol: null
        }
      : {
          status: snapshot.lowBalance ? "funding_required" : "ready",
          address: snapshot.address,
          balanceSol
        };
  }

  let reserve: WorkspaceSetupProgress["reserve"];
  if (reserveResult.status === "rejected") {
    reserve = { status: "unavailable" };
  } else {
    const snapshot = reserveResult.value;
    if (snapshot.status === "no_reserve") {
      reserve = { status: "key_custody_required" };
    } else if (snapshot.status === "workspace_program_not_initialized") {
      reserve = { status: "workspace_program_not_initialized" };
    } else if (
      snapshot.status === "program_configured" &&
      snapshot.programReserveConfigured === true &&
      snapshot.confidentialTransferReady === true
    ) {
      reserve = { status: "ready" };
    } else if (
      snapshot.status === "not_configured"
    ) {
      reserve = { status: "unavailable" };
    } else {
      reserve = { status: "setup_required" };
    }
  }

  return {
    gasTank,
    reserve,
    complete: gasTank.status === "ready" && reserve.status === "ready"
  };
}
