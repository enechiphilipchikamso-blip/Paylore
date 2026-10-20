import "server-only";

import {
  address,
  getAddressEncoder
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  TOKEN_2022_PROGRAM_ADDRESS
} from "@solana-program/token-2022";
import { loadPayloreConfig } from "./config";
import { readSolanaRpc } from "./solana/rpc";

export type ReserveAccountReconciliation =
  | { status: "no_reserve"; tokenAccount: null }
  | { status: "not_configured"; tokenAccount: null }
  | { status: "account_missing"; tokenAccount: string }
  | { status: "account_verified"; tokenAccount: string };

export function verifyReserveTokenAccount(input: {
  account: {
    owner: string;
    data: readonly [string, string];
  } | null;
  expectedOwner: string;
  expectedMint: string;
}): "account_missing" | "account_verified" {
  if (!input.account) return "account_missing";
  if (
    input.account.owner !== TOKEN_2022_PROGRAM_ADDRESS ||
    typeof input.account.data[0] !== "string" ||
    input.account.data[1] !== "base64"
  ) {
    throw new Error("The reserve Token-2022 account identity is invalid.");
  }
  const bytes = Buffer.from(input.account.data[0], "base64");
  if (
    bytes.toString("base64") !== input.account.data[0] ||
    bytes.length < 165
  ) {
    throw new Error("The reserve Token-2022 account data is malformed.");
  }
  const encoder = getAddressEncoder();
  const mintBytes = encoder.encode(address(input.expectedMint));
  const ownerBytes = encoder.encode(address(input.expectedOwner));
  if (
    !bytes.subarray(0, 32).equals(Buffer.from(mintBytes)) ||
    !bytes.subarray(32, 64).equals(Buffer.from(ownerBytes))
  ) {
    throw new Error("The reserve Token-2022 account owner or mint does not match.");
  }
  return "account_verified";
}

export async function reconcileWorkspaceReserveAccount(
  reserveAddress: string | null
): Promise<ReserveAccountReconciliation> {
  if (!reserveAddress) {
    return { status: "no_reserve", tokenAccount: null };
  }
  const mint = loadPayloreConfig().PAYLORE_WRAPPED_USDC_MINT;
  if (!mint) {
    return { status: "not_configured", tokenAccount: null };
  }
  const owner = address(reserveAddress);
  const wrappedMint = address(mint);
  const [tokenAccount] = await findAssociatedTokenPda({
    owner,
    mint: wrappedMint,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS
  });
  const accountInfo = await readSolanaRpc<{
    value: {
      owner: string;
      data: [string, string];
    } | null;
  }>("getAccountInfo", [
    tokenAccount,
    { commitment: "finalized", encoding: "base64" }
  ]);
  const status = verifyReserveTokenAccount({
    account: accountInfo.value,
    expectedOwner: reserveAddress,
    expectedMint: mint
  });
  return { status, tokenAccount };
}
