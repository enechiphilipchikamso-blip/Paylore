import { describe, expect, it } from "vitest";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { address, getAddressEncoder } from "@solana/kit";
import { createSubscriptionPaymentTransaction } from "./subscription-payment-transaction";

const PAYER = "Vote111111111111111111111111111111111111111";
const RECIPIENT = "Stake11111111111111111111111111111111111111";
const CONFIDENTIAL_USDC_MINT = "8wZmMHQY3bCJMhWs8j6BLxvgNLUkCXB2F5tEZPFF8A6q";
const CLASSIC_USDC_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const CLASSIC_TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const PAYMENT_MEMO = "Paylore activation attempt test | workspace workspace-test";
const TRANSFER_CHECKED_49_USDC = [12, 0x40, 0xae, 0xeb, 0x02, 0, 0, 0, 0, 6];

function contains(transaction: Uint8Array, value: ArrayLike<number>): boolean {
  return Buffer.from(transaction).includes(Buffer.from(Array.from(value)));
}

function expectPaymentPayload(
  transaction: Uint8Array,
  input: { payer: string; recipient: string; mint: string; tokenProgram: string; memo: string }
) {
  expect(contains(transaction, getAddressEncoder().encode(address(input.payer)))).toBe(true);
  expect(contains(transaction, getAddressEncoder().encode(address(input.recipient)))).toBe(true);
  expect(contains(transaction, getAddressEncoder().encode(address(input.mint)))).toBe(true);
  expect(contains(transaction, getAddressEncoder().encode(address(input.tokenProgram)))).toBe(true);
  expect(contains(transaction, TRANSFER_CHECKED_49_USDC)).toBe(true);
  expect(contains(transaction, Buffer.from(input.memo))).toBe(true);
  expect(contains(transaction, Buffer.from("Paylore workspace activation | 49 USDC | recipient "))).toBe(false);
}

describe("subscription payment transaction", () => {
  it("builds an exact $49 USDC Token-2022 payment with the supplied wallet, recipient and attempt memo", async () => {
    const transaction = await createSubscriptionPaymentTransaction({
      payer: PAYER,
      recipient: RECIPIENT,
      mint: CONFIDENTIAL_USDC_MINT,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      workspaceId: "workspace-test",
      memo: PAYMENT_MEMO,
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 100
    });

    expect(transaction[0]).toBe(1);
    expect(transaction.slice(1, 65)).toEqual(new Uint8Array(64));
    expect(transaction[65]).toBe(0x80);
    expect(transaction.length).toBeGreaterThan(150);
    expectPaymentPayload(transaction, {
      payer: PAYER,
      recipient: RECIPIENT,
      mint: CONFIDENTIAL_USDC_MINT,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      memo: PAYMENT_MEMO
    });
  });

  it("builds the same exact payment through the configured classic SPL Token program for Circle Devnet USDC", async () => {
    const memo = "Paylore activation attempt test | workspace workspace-classic-usdc";
    const transaction = await createSubscriptionPaymentTransaction({
      payer: PAYER,
      recipient: RECIPIENT,
      mint: CLASSIC_USDC_MINT,
      tokenProgram: CLASSIC_TOKEN_PROGRAM,
      workspaceId: "workspace-classic-usdc",
      memo,
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 100
    });

    expectPaymentPayload(transaction, {
      payer: PAYER,
      recipient: RECIPIENT,
      mint: CLASSIC_USDC_MINT,
      tokenProgram: CLASSIC_TOKEN_PROGRAM,
      memo
    });
  });

  it("rejects a token program not supported for subscription payments", async () => {
    await expect(createSubscriptionPaymentTransaction({
      payer: PAYER,
      recipient: RECIPIENT,
      mint: CLASSIC_USDC_MINT,
      tokenProgram: "11111111111111111111111111111111",
      workspaceId: "workspace-test",
      memo: PAYMENT_MEMO,
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 100
    })).rejects.toThrow("unsupported token program");
  });
});
