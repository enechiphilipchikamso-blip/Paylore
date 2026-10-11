import { afterEach, describe, expect, it, vi } from "vitest";
import { POST } from "./route";

afterEach(() => {
  vi.unstubAllEnvs();
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

  it("accepts an authenticated bounded event array without persisting payloads", async () => {
    vi.stubEnv("PAYLORE_HELIUS_WEBHOOK_SECRET", "webhook-test-secret");

    const response = await POST(new Request("https://paylore.example/api/webhooks/helius", {
      method: "POST",
      headers: { authorization: "Bearer webhook-test-secret" },
      body: JSON.stringify([{ signature: "transaction" }])
    }));

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ status: "accepted", events: 1 });
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
});
