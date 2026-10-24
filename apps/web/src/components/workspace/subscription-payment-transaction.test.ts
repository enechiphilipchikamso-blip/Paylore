import { describe, expect, it } from "vitest";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { address, getAddressEncoder } from "@solana/kit";
import { createSubscriptionPaymentTransaction } from "./subscription-payment-transaction";

describe("subscription payment transaction", () => {
  it("builds a Token-2022 USDC payment transaction for wallet approval", async () => {
    const transaction = await createSubscriptionPaymentTransaction({
      payer: "11111111111111111111111111111111",
      recipient: "Vote111111111111111111111111111111111111111",
      mint: "8wZmMHQY3bCJMhWs8j6BLxvgNLUkCXB2F5tEZPFF8A6q",
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      workspaceId: "workspace-test",
      memo: "Paylore activation attempt test | workspace workspace-test",
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 100
    });

    expect(transaction[0]).toBe(1);
    expect(transaction.slice(1, 65)).toEqual(new Uint8Array(64));
    expect(transaction[65]).toBe(0x80);
    expect(transaction.length).toBeGreaterThan(150);
    expect(Buffer.from(transaction).includes(
      Buffer.from(
        getAddressEncoder().encode(
          address(TOKEN_2022_PROGRAM_ADDRESS)
        )
      )
    )).toBe(true);
    expect(Buffer.from(transaction).includes(
      Buffer.from("Paylore activation attempt test | workspace workspace-test")
    )).toBe(true);
    expect(Buffer.from(transaction).includes(
      Buffer.from("Paylore workspace activation | 49 USDC | recipient ")
    )).toBe(false);
  });
 
  it("builds a classic SPL Token payment for a classic USDC mint", async () => {
    const classicTokenProgram = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
    const recipient = "Vote111111111111111111111111111111111111111";
    const transaction = await createSubscriptionPaymentTransaction({
      payer: "11111111111111111111111111111111",
      recipient,
      mint: "4zMMC9srt5Ri5X14GAgXha3i3GnPAEERYPJgZJDncDU",
      tokenProgram: classicTokenProgram,
      workspaceId: "workspace-classic-usdc",
      memo: "Paylore activation attempt test | workspace workspace-classic-usdc",
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 100
    });

    expect(Buffer.from(transaction).includes(
      Buffer.from(getAddressEncoder().encode(address(classicTokenProgram)))
    )).toBe(true);
    expect(Buffer.from(transaction).includes(
      Buffer.from("Paylore activation attempt test | workspace workspace-classic-usdc")
    )).toBe(true);
    expect(Buffer.from(transaction).includes(
      Buffer.from("Paylore workspace activation | 49 USDC | recipient ")
    )).toBe(false);
  });

  it("rejects a token program not supported for subscription payments", async () => {
    await expect(createSubscriptionPaymentTransaction({
      payer: "11111111111111111111111111111111",
      recipient: "Vote111111111111111111111111111111111111111",
      mint: "4zMMC9srt5Ri5X14GAgXha3i3GnPAEERYPJgZJDncDU",
      tokenProgram: "11111111111111111111111111111111",
      workspaceId: "workspace-test",
      memo: "Paylore activation attempt test | workspace workspace-test",
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 100
    })).rejects.toThrow("unsupported token program");
  });

});
