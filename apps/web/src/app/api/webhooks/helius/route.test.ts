import { afterEach, describe, expect, it, vi } from "vitest";
import { persistSolanaWebhookEvents } from "@paylore/database";
import { POST } from "./route";

vi.mock("server-only", () => ({}));
vi.mock("../../../../server/db", () => ({
  getDatabase: () => ({})
}));
vi.mock("@paylore/database", () => ({
  persistSolanaWebhookEvents: vi.fn()
}));

afterEach(() => {
  vi.unstubAllEnvs();
  vi.mocked(persistSolanaWebhookEvents).mockReset();
});

describe("Helius webhook intake", () => {
  it("rejects requests unless they use the configured Authorization header", async () => {
    vi.stubEnv("PAYLORE_HELIUS_WEBHOOK_SECRET", "webhook-test-secret");

    const response = await POST(new Request("https://paylore.example/api/webhooks/helius", {
      method: "POST",
      body: JSON.stringify([{ signature: "transaction" }])
    }));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
  });

  it("durably accepts normalized authenticated events", async () => {
    vi.stubEnv("PAYLORE_HELIUS_WEBHOOK_SECRET", "webhook-test-secret");
    vi.mocked(persistSolanaWebhookEvents).mockResolvedValue({
      inserted: 1,
      duplicates: 0
    });

    const response = await POST(new Request("https://paylore.example/api/webhooks/helius", {
      method: "POST",
      headers: { authorization: "Bearer webhook-test-secret" },
      body: JSON.stringify([{ signature: "1".repeat(64), slot: 12 }])
    }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: "received",
      events: 1,
      inserted: 1,
      duplicates: 0
    });
    expect(persistSolanaWebhookEvents).toHaveBeenCalledWith(
      {},
      [{
        provider: "helius",
        providerEventId: "1".repeat(64),
        transactionSignature: "1".repeat(64),
        transactionSlot: "12",
        accountAddress: null,
        eventType: null,
        payload: {
          signature: "1".repeat(64),
          slot: 12,
          type: null
        },
        status: "received"
      }]
    );
  });

  it("rejects authenticated payloads outside the webhook event shape", async () => {
    vi.stubEnv("PAYLORE_HELIUS_WEBHOOK_SECRET", "webhook-test-secret");

    const response = await POST(new Request("https://paylore.example/api/webhooks/helius", {
      method: "POST",
      headers: { authorization: "Bearer webhook-test-secret" },
      body: JSON.stringify({ signature: "transaction" })
    }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_payload" });
  });
  it("acknowledges a replayed event without counting it as a new insert", async () => {
    vi.stubEnv("PAYLORE_HELIUS_WEBHOOK_SECRET", "webhook-test-secret");
    vi.mocked(persistSolanaWebhookEvents).mockResolvedValue({ inserted: 0, duplicates: 1 });
    const event = { signature: "2".repeat(64), slot: 13 };
    const response = await POST(new Request("https://paylore.example/api/webhooks/helius", {
      method: "POST", headers: { authorization: "Bearer webhook-test-secret" }, body: JSON.stringify([event])
    }));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({ status: "received", events: 1, inserted: 0, duplicates: 1 });
    expect(persistSolanaWebhookEvents).toHaveBeenCalledOnce();
  });

});
