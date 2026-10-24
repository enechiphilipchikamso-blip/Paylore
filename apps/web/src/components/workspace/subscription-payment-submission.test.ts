import { describe, expect, it, vi } from "vitest";
import type { findAuthenticatedWallet } from "./authenticated-wallet";
import { beginSubscriptionWalletApproval } from "./subscription-payment-submission";

const PAYER = "11111111111111111111111111111111";
const OTHER_PAYER = "Vote111111111111111111111111111111111111111";
const transaction = new Uint8Array([1, 2, 3]);

function authenticatedWallet(address: string) {
  const submission = Promise.resolve([{ signature: new Uint8Array(64) }]);
  const signAndSendTransaction = vi.fn(() => submission);
  const wallet = {
    account: {
      address,
      publicKey: new Uint8Array(32),
      chains: ["solana:devnet"],
      features: ["solana:signAndSendTransaction"]
    },
    signAndSendTransaction
  } as unknown as ReturnType<typeof findAuthenticatedWallet>;
  return { wallet, signAndSendTransaction, submission };
}

describe("beginSubscriptionWalletApproval", () => {
  it("invokes the wallet synchronously with the exact prepared transaction and Devnet context", async () => {
    const fixture = authenticatedWallet(PAYER);

    const result = beginSubscriptionWalletApproval(fixture.wallet, {
      payer: PAYER,
      transaction
    });

    expect(fixture.signAndSendTransaction).toHaveBeenCalledOnce();
    expect(fixture.signAndSendTransaction).toHaveBeenCalledWith({
      account: fixture.wallet.account,
      transaction,
      chain: "solana:devnet",
      options: { commitment: "confirmed" }
    });
    expect(result).toBe(fixture.submission);
    await expect(result).resolves.toHaveLength(1);
  });

  it("does not open a wallet request when the signed-in payer does not match the prepared payer", () => {
    const fixture = authenticatedWallet(PAYER);

    expect(() => beginSubscriptionWalletApproval(fixture.wallet, {
      payer: OTHER_PAYER,
      transaction
    })).toThrow("Your authenticated wallet changed. Sign in again before paying.");
    expect(fixture.signAndSendTransaction).not.toHaveBeenCalled();
  });
});
