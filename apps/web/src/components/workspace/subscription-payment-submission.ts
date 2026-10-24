import type { findAuthenticatedWallet } from "./authenticated-wallet";
import { isWalletCancellation } from "../auth/walletErrors";

type AuthenticatedWallet = ReturnType<typeof findAuthenticatedWallet>;

export function beginSubscriptionWalletApproval(
  wallet: AuthenticatedWallet,
  input: { payer: string; transaction: Uint8Array }
) {
  if (wallet.account.address !== input.payer) {
    throw new Error("Your authenticated wallet changed. Sign in again before paying.");
  }

  return wallet.signAndSendTransaction({
    account: wallet.account,
    transaction: input.transaction,
    chain: "solana:devnet",
    options: { commitment: "confirmed" }
  });
}

/** An abort can happen after wallet submission begins, so only explicit wallet rejection is a safe cancellation. */
export function isConfirmedWalletCancellation(cause: unknown): boolean {
  if (cause instanceof Error && cause.name === "AbortError") return false;
  return isWalletCancellation(cause);
}
