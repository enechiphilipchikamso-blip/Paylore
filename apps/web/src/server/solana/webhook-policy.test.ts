import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  normalizeHeliusWebhookPayload,
  normalizeQuickNodeWebhookPayload,
  verifyQuickNodeWebhookHmac
} from "./webhook-policy";

const signature = "1".repeat(64);

describe("Helius webhook normalization", () => {
  it("keeps only reconciliation identifiers and deduplicates repeated signatures", () => {
    const events = normalizeHeliusWebhookPayload([
      {
        signature,
        slot: 42,
        type: "UNKNOWN",
        accountData: [{ account: "not-retained" }]
      },
      { signature, slot: 42, type: "UNKNOWN" }
    ]);

    expect(events).toEqual([{
      provider: "helius",
      providerEventId: signature,
      transactionSignature: signature,
      transactionSlot: "42",
      eventType: "UNKNOWN",
      payload: {
        signature,
        slot: 42,
        type: "UNKNOWN"
      }
    }]);
  });

  it("rejects unsigned, malformed, or oversized deliveries", () => {
    expect(normalizeHeliusWebhookPayload([{ slot: 42 }])).toBeNull();
    expect(
      normalizeHeliusWebhookPayload([{ signature: "not-a-signature" }])
    ).toBeNull();
    expect(
      normalizeHeliusWebhookPayload(
        Array.from({ length: 101 }, () => ({ signature }))
      )
    ).toBeNull();
  });
});

describe("QuickNode webhook verification and normalization", () => {
  it("verifies the provider HMAC over nonce, timestamp, and payload", () => {
    const input = {
      secret: "quicknode-secret",
      nonce: "delivery-1",
      timestamp: "2026-10-13T00:00:00Z",
      payload: JSON.stringify([{ signature, slot: 42, type: "PAYROLL" }])
    };
    const signatureValue = createHmac("sha256", input.secret)
      .update(input.nonce + input.timestamp + input.payload)
      .digest("hex");

    expect(
      verifyQuickNodeWebhookHmac({ ...input, signature: signatureValue })
    ).toBe(true);
    expect(
      verifyQuickNodeWebhookHmac({
        ...input,
        payload: `${input.payload} `,
        signature: signatureValue
      })
    ).toBe(false);
  });

  it("keeps only event identifiers and deduplicates transaction signatures", () => {
    const events = normalizeQuickNodeWebhookPayload([
      {
        signature,
        slot: 42,
        type: "PAYROLL",
        accountData: [{ account: "not-retained" }]
      },
      { signature, slot: 42, type: "PAYROLL" }
    ]);

    expect(events).toEqual([{
      provider: "quicknode",
      providerEventId: signature,
      transactionSignature: signature,
      transactionSlot: "42",
      eventType: "PAYROLL",
      payload: {
        signature,
        slot: 42,
        type: "PAYROLL"
      }
    }]);
  });

  it("rejects invalid and oversized QuickNode event payloads", () => {
    expect(normalizeQuickNodeWebhookPayload({ signature: "bad" })).toBeNull();
    expect(
      normalizeQuickNodeWebhookPayload(
        Array.from({ length: 101 }, () => ({ signature }))
      )
    ).toBeNull();
  });
});
