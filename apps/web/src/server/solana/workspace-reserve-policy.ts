import { address, getAddressEncoder } from "@solana/kit";
import { createHash } from "node:crypto";

const encoder = new TextEncoder();

export type EncodedWorkspaceState = {
  owner: string;
  executable?: boolean;
  data: readonly [string, string];
} | null;

export type WorkspaceStateVerification =
  | { status: "workspace_program_not_initialized" }
  | { status: "workspace_verified" };

function discriminator(name: string): Uint8Array {
  return createHash("sha256").update(name).digest().subarray(0, 8);
}

/** A workspace PDA is usable only when its initialized authority and seed bind to the app workspace ID. */
export function verifyWorkspaceProgramState(input: {
  account: EncodedWorkspaceState;
  programId: string;
  authorityAddress: string;
  workspaceId: string;
  workspaceSeed: Uint8Array;
  expectedBump: number;
}): WorkspaceStateVerification {
  if (!input.account) return { status: "workspace_program_not_initialized" };
  if (
    input.account.owner !== input.programId ||
    input.account.executable === true ||
    !Array.isArray(input.account.data) ||
    typeof input.account.data[0] !== "string" ||
    input.account.data[1] !== "base64"
  ) throw new Error("The Payroll Program workspace account identity is invalid.");

  const base64 = input.account.data[0];
  const data = Buffer.from(base64, "base64");
  if (
    data.toString("base64") !== base64 ||
    data.length !== 8 + 32 + 4 + 64 + 32 + 1 ||
    !data.subarray(0, 8).equals(Buffer.from(discriminator("account:WorkspaceState")))
  ) throw new Error("The Payroll Program workspace account data is malformed.");

  const workspaceBytes = encoder.encode(input.workspaceId);
  if (
    workspaceBytes.length < 1 ||
    workspaceBytes.length > 64 ||
    data.readUInt32LE(40) !== workspaceBytes.length
  ) throw new Error("The Payroll Program workspace identifier is invalid.");

  const idStart = 44;
  const seedStart = idStart + workspaceBytes.length;
  const bumpOffset = seedStart + 32;
  if (
    !data.subarray(8, 40).equals(Buffer.from(getAddressEncoder().encode(address(input.authorityAddress)))) ||
    !data.subarray(idStart, idStart + workspaceBytes.length).equals(Buffer.from(workspaceBytes)) ||
    !data.subarray(seedStart, seedStart + 32).equals(Buffer.from(input.workspaceSeed)) ||
    data[bumpOffset] !== input.expectedBump
  ) throw new Error("The Payroll Program workspace account does not match the configured workspace.");

  return { status: "workspace_verified" };
}

export function hasApprovedConfidentialTransferAccount(
  token: {
    owner: string;
    mint: string;
    extensions: readonly {
      __kind: string;
      approved?: boolean;
      allowConfidentialCredits?: boolean;
    }[];
  },
  input: { owner: string; mint: string }
): boolean {
  const extension = token.extensions.find((item) => item.__kind === "ConfidentialTransferAccount");
  return token.owner === input.owner &&
    token.mint === input.mint &&
    extension?.approved === true &&
    extension.allowConfidentialCredits === true;
}


export type ReserveFundingState =
  | "unfunded"
  | "public_funds_available"
  | "pending_confidential_balance"
  | "confidential_funds_available";

/** Classifies only canonical integer balances read from finalized reserve account state. */
export function classifyReserveFundingState(input: {
  publicBalanceBaseUnits: string;
  availableBalanceBaseUnits: string;
  pendingBalanceBaseUnits: string;
}): ReserveFundingState {
  const parseBalance = (value: string, label: string): bigint => {
    if (!/^(0|[1-9][0-9]*)$/.test(value)) {
      throw new Error(`The reserve ${label} balance is invalid.`);
    }
    return BigInt(value);
  };
  const publicBalance = parseBalance(input.publicBalanceBaseUnits, "public");
  const availableBalance = parseBalance(input.availableBalanceBaseUnits, "available confidential");
  const pendingBalance = parseBalance(input.pendingBalanceBaseUnits, "pending confidential");
  if (availableBalance > 0n) return "confidential_funds_available";
  if (pendingBalance > 0n) return "pending_confidential_balance";
  if (publicBalance > 0n) return "public_funds_available";
  return "unfunded";
}
