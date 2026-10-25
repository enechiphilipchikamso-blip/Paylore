import { describe, expect, it } from "vitest";
import {
  getWebhookTransactionBindingError,
  normalizeHeliusWebhookPayload
} from "./webhook-policy";

const signature = "1".repeat(64);
const account = "Vote111111111111111111111111111111111111111";
const otherAccount = "11111111111111111111111111111111";

describe("Helius webhook normalization", () => {
  it("keeps only reconciliation identifiers, records a deterministic account hint, and deduplicates signatures", () => {
    const events = normalizeHeliusWebhookPayload([
      {
        signature,
        slot: 42,
        type: "UNKNOWN",
        accountData: [
          { account, nativeBalanceChange: 900, tokenBalanceChanges: [{ mint: "not-retained" }] }
        ],
        description: "not-retained"
      },
      { signature, slot: 42, type: "UNKNOWN", accountData: [{ account }] }
    ]);

    expect(events).toEqual([{
      provider: "helius",
      providerEventId: signature,
      transactionSignature: signature,
      transactionSlot: "42",
      accountAddress: account,
      eventType: "UNKNOWN",
      payload: { signature, slot: 42, type: "UNKNOWN" }
    }]);
  });

  it("accepts events without optional account hints", () => {
    expect(normalizeHeliusWebhookPayload([{ signature }])).toEqual([{
      provider: "helius",
      providerEventId: signature,
      transactionSignature: signature,
      transactionSlot: null,
      accountAddress: null,
      eventType: null,
      payload: { signature, slot: null, type: null }
    }]);
  });

  it("rejects conflicting duplicate observations for the same signature", () => {
    expect(normalizeHeliusWebhookPayload([
      { signature, slot: 42, accountData: [{ account }] },
      { signature, slot: 43, accountData: [{ account }] }
    ])).toBeNull();
    expect(normalizeHeliusWebhookPayload([
      { signature, slot: 42, accountData: [{ account }] },
      { signature, slot: 42, accountData: [{ account: otherAccount }] }
    ])).toBeNull();
  });

  it("rejects malformed addresses and oversized account hints", () => {
    expect(normalizeHeliusWebhookPayload([
      { signature, accountData: [{ account: "not-an-address" }] }
    ])).toBeNull();
    expect(normalizeHeliusWebhookPayload([
      { signature, accountData: Array.from({ length: 257 }, () => ({ account })) }
    ])).toBeNull();
  });

  it("rejects unsigned, malformed, or oversized deliveries", () => {
    expect(normalizeHeliusWebhookPayload([{ slot: 42 }])).toBeNull();
    expect(normalizeHeliusWebhookPayload([{ signature: "not-a-signature" }])).toBeNull();
    expect(normalizeHeliusWebhookPayload(
      Array.from({ length: 101 }, () => ({ signature }))
    )).toBeNull();
  });
});

describe("Helius transaction trust boundary", () => {
  const transaction = {
    slot: 42,
    transaction: {
      signatures: [signature],
      message: { accountKeys: [
        { pubkey: account, signer: false },
        { pubkey: otherAccount, signer: true }
      ] }
    }
  };

  it("accepts RPC evidence when signature, slot, and account hint all bind", () => {
    expect(getWebhookTransactionBindingError({
      requestedSignature: signature,
      expectedSlot: "42",
      accountAddress: account,
      transaction
    })).toBeNull();
  });

  it.each([
    ["signature", { ...transaction, transaction: {
      ...transaction.transaction, signatures: ["2".repeat(64)]
    } }, "transaction_signature_mismatch"],
    ["slot", { ...transaction, slot: 43 }, "transaction_slot_mismatch"],
    ["account", { ...transaction, transaction: {
      ...transaction.transaction, message: { accountKeys: [otherAccount] }
    } }, "webhook_account_hint_mismatch"],
    ["invalid slot", { ...transaction, slot: Number.MAX_SAFE_INTEGER + 1 }, "transaction_slot_invalid"]
  ])("rejects a mismatched %s", (_name, candidate, expected) => {
    expect(getWebhookTransactionBindingError({
      requestedSignature: signature,
      expectedSlot: "42",
      accountAddress: account,
      transaction: candidate
    })).toBe(expected);
  });

  it("does not require an account hint when none was delivered", () => {
    expect(getWebhookTransactionBindingError({
      requestedSignature: signature,
      expectedSlot: null,
      accountAddress: null,
      transaction
    })).toBeNull();
  });
});
