import { describe, expect, it } from "vitest";
import { createSubscriptionPaymentTransaction } from "./subscription-payment-transaction";

describe("subscription payment transaction", () => {
  it("builds an unsigned Devnet USDC transfer transaction for wallet approval", async () => {
    const transaction = await createSubscriptionPaymentTransaction({
      payer: "11111111111111111111111111111111",
      recipient: "Vote111111111111111111111111111111111111111",
      mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 100
    });

    expect(transaction[0]).toBe(1);
    expect(transaction.slice(1, 65)).toEqual(new Uint8Array(64));
    expect(transaction[65]).toBe(0x80);
    expect(transaction.length).toBeGreaterThan(150);
  });
});
