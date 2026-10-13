import { createHmac } from "node:crypto";
import { gzipSync } from "node:zlib";
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

function signedRequest(payload: string, secret: string) {
  const nonce = "delivery-1";
  const timestamp = "2026-10-13T00:00:00Z";
  const signature = createHmac("sha256", secret)
    .update(nonce + timestamp + payload)
    .digest("hex");
  return new Request("https://paylore.example/api/webhooks/quicknode", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-qn-nonce": nonce,
      "x-qn-timestamp": timestamp,
      "x-qn-signature": signature
    },
    body: payload
  });
}

function signedGzipRequest(payload: string, secret: string) {
  const nonce = "delivery-gzip-1";
  const timestamp = "2026-10-13T00:00:00Z";
  const signature = createHmac("sha256", secret)
    .update(nonce + timestamp + payload)
    .digest("hex");
  return new Request("https://paylore.example/api/webhooks/quicknode", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-encoding": "gzip",
      "x-qn-nonce": nonce,
      "x-qn-timestamp": timestamp,
      "x-qn-signature": signature
    },
    body: gzipSync(Buffer.from(payload))
  });
}

describe("QuickNode webhook intake", () => {
  it("rejects missing or invalid provider signatures", async () => {
    vi.stubEnv("PAYLORE_QUICKNODE_WEBHOOK_SECRET", "quicknode-secret");
    const request = signedRequest(
      JSON.stringify([{ signature: "1".repeat(64) }]),
      "another-secret"
    );

    const response = await POST(request);

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(persistSolanaWebhookEvents).not.toHaveBeenCalled();
  });

  it("persists authenticated normalized QuickNode events", async () => {
    vi.stubEnv("PAYLORE_QUICKNODE_WEBHOOK_SECRET", "quicknode-secret");
    vi.mocked(persistSolanaWebhookEvents).mockResolvedValue({
      inserted: 1,
      duplicates: 0
    });
    const payload = JSON.stringify([
      { signature: "1".repeat(64), slot: 12, type: "PAYROLL" }
    ]);

    const response = await POST(
      signedRequest(payload, "quicknode-secret")
    );

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
        provider: "quicknode",
        providerEventId: "1".repeat(64),
        transactionSignature: "1".repeat(64),
        transactionSlot: "12",
        eventType: "PAYROLL",
        payload: {
          signature: "1".repeat(64),
          slot: 12,
          type: "PAYROLL"
        },
        status: "received"
      }]
    );
  });

  it("verifies gzip deliveries over the decoded JSON payload", async () => {
    vi.stubEnv("PAYLORE_QUICKNODE_WEBHOOK_SECRET", "quicknode-secret");
    vi.mocked(persistSolanaWebhookEvents).mockResolvedValue({
      inserted: 1,
      duplicates: 0
    });
    const payload = JSON.stringify([
      { signature: "2".repeat(64), slot: 15, type: "PAYROLL" }
    ]);

    const response = await POST(
      signedGzipRequest(payload, "quicknode-secret")
    );

    expect(response.status).toBe(202);
  });

  it("rejects payloads that do not use the configured event shape", async () => {
    vi.stubEnv("PAYLORE_QUICKNODE_WEBHOOK_SECRET", "quicknode-secret");

    const response = await POST(
      signedRequest(JSON.stringify({ signature: "not-a-signature" }), "quicknode-secret")
    );

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_payload" });
  });
});
