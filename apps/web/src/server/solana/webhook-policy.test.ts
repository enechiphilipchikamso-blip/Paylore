import { describe, expect, it } from "vitest";
import { normalizeHeliusWebhookPayload } from "./webhook-policy";

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
