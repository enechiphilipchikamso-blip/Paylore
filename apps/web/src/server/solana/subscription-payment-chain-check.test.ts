import { describe, expect, it } from "vitest";
import { isExactSubscriptionPaymentTransaction } from "./subscription-payment-chain-check";

const expected = {
  signature: "5".repeat(64),
  payerAddress: "payer-wallet",
  recipient: "workspace-recipient",
  mint: "usdc-mint",
  amountBaseUnits: "49000000"
};

function transaction(overrides: {
  err?: unknown;
  signature?: string;
  amount?: string;
  mint?: string;
  payerSigner?: boolean;
  recipientOwner?: string;
} = {}) {
  return {
    transaction: {
      signatures: [overrides.signature ?? expected.signature],
      message: {
        accountKeys: [
          { pubkey: "source-token-account", signer: false },
          { pubkey: "destination-token-account", signer: false },
          { pubkey: expected.payerAddress, signer: overrides.payerSigner ?? true }
        ],
        instructions: [{
          program: "spl-token",
          parsed: {
            type: "transferChecked",
            info: {
              source: "source-token-account",
              destination: "destination-token-account",
              mint: overrides.mint ?? expected.mint,
              tokenAmount: {
                amount: overrides.amount ?? expected.amountBaseUnits,
                decimals: 6
              }
            }
          }
        }]
      }
    },
    meta: {
      err: overrides.err ?? null,
      preTokenBalances: [{
        accountIndex: 0,
        mint: expected.mint,
        owner: expected.payerAddress
      }],
      postTokenBalances: [{
        accountIndex: 1,
        mint: expected.mint,
        owner: overrides.recipientOwner ?? expected.recipient
      }]
    }
  };
}

describe("isExactSubscriptionPaymentTransaction", () => {
  it("accepts only a successful exact payment signed by the stored payer", () => {
    expect(isExactSubscriptionPaymentTransaction(transaction(), expected)).toBe(true);
  });

  it("rejects a failed chain transaction", () => {
    expect(isExactSubscriptionPaymentTransaction(transaction({ err: { InstructionError: [0, "Custom"] } }), expected)).toBe(false);
  });

  it("rejects a signature mismatch", () => {
    expect(isExactSubscriptionPaymentTransaction(transaction({ signature: "6".repeat(64) }), expected)).toBe(false);
  });

  it("rejects an incorrect amount, mint, recipient owner, or unsigned payer", () => {
    expect(isExactSubscriptionPaymentTransaction(transaction({ amount: "48999999" }), expected)).toBe(false);
    expect(isExactSubscriptionPaymentTransaction(transaction({ mint: "wrong-mint" }), expected)).toBe(false);
    expect(isExactSubscriptionPaymentTransaction(transaction({ recipientOwner: "attacker" }), expected)).toBe(false);
    expect(isExactSubscriptionPaymentTransaction(transaction({ payerSigner: false }), expected)).toBe(false);
  });

  it("rejects malformed transaction data", () => {
    expect(isExactSubscriptionPaymentTransaction(null, expected)).toBe(false);
    expect(isExactSubscriptionPaymentTransaction({ transaction: {}, meta: null }, expected)).toBe(false);
  });
});
