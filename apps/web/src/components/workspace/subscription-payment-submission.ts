import type { SolanaSignAndSendTransactionOutput } from "@solana/wallet-standard-features";
import type { findAuthenticatedWallet } from "./authenticated-wallet";

type AuthenticatedWallet = ReturnType<typeof findAuthenticatedWallet>;

export function beginSubscriptionWalletApproval(
  wallet: AuthenticatedWallet,
  input: { payer: string; transaction: Uint8Array }
): Promise<readonly SolanaSignAndSendTransactionOutput[]> {
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
