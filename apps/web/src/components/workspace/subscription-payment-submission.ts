import type { findAuthenticatedWallet } from "./authenticated-wallet";
import { isWalletCancellation } from "../auth/walletErrors";

type AuthenticatedWallet = ReturnType<typeof findAuthenticatedWallet>;

export const SUBSCRIPTION_PAYMENT_MISMATCH =
  "The wallet transaction details do not match this Paylore payment. Cancel the request and contact support before trying again.";

export function beginSubscriptionWalletApproval(
  wallet: AuthenticatedWallet,
  input: { payer: string; transaction: Uint8Array }
) {
  if (wallet.account.address !== input.payer) {
    throw new Error(SUBSCRIPTION_PAYMENT_MISMATCH);
  }

  return wallet.signAndSendTransaction({
    account: wallet.account,
    transaction: input.transaction,
    chain: "solana:devnet"
  });
}

/** An abort can happen after wallet submission begins, so only explicit wallet rejection is a safe cancellation. */
export function isConfirmedWalletCancellation(cause: unknown): boolean {
  if (cause instanceof Error && cause.name === "AbortError") return false;
  return isWalletCancellation(cause);
}
