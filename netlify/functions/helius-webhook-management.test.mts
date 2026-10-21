import { describe, expect, it, vi } from "vitest";
import { reconcileHeliusWebhookAddresses } from "./helius-webhook-management.mjs";

const addresses = ["A-address", "Z-address"];
const current = {
  webhookID: "webhook-id",
  webhookURL: "https://paylore.netlify.app/api/webhooks/helius",
  transactionTypes: ["ANY"],
  accountAddresses: ["A-address"],
  webhookType: "enhanced",
  authHeader: "redacted-test-secret"
};

function setup(options: {
  current?: Record<string, unknown>;
  updated?: Record<string, unknown>;
  getStatus?: number;
  putStatus?: number;
} = {}) {
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PUT") {
      return new Response(JSON.stringify(options.updated ?? {
        ...options.current ?? current,
        accountAddresses: addresses
      }), { status: options.putStatus ?? 200 });
    }
    return new Response(JSON.stringify(options.current ?? current), {
      status: options.getStatus ?? 200
    });
  }) as unknown as typeof fetch;
  const db = {} as never;
  return { db, fetchImpl };
}

describe("dynamic Helius webhook address reconciliation", () => {
  it("updates only the monitored address set and reads back the result", async () => {
    const { db, fetchImpl } = setup();
    const list = await import("../../packages/database/src/index");
    const listSpy = vi.spyOn(list, "listHeliusMonitoredAddresses").mockResolvedValue(addresses);
    try {
      const result = await reconcileHeliusWebhookAddresses(db, {
        apiKey: "test-api-key",
        webhookId: "webhook-id",
        expectedWebhookUrl: "https://paylore.netlify.app/api/webhooks/helius",
        fetchImpl
      });
      expect(result).toEqual({ status: "updated", addressCount: 2 });
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      const update = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1][1] as RequestInit;
      expect(JSON.parse(String(update.body))).toMatchObject({
        webhookURL: current.webhookURL,
        transactionTypes: current.transactionTypes,
        accountAddresses: addresses,
        webhookType: current.webhookType,
        authHeader: current.authHeader
      });
    } finally {
      listSpy.mockRestore();
    }
  });

  it("does not call Helius when management is not configured", async () => {
    const fetchImpl = vi.fn();
    const result = await reconcileHeliusWebhookAddresses({} as never, {
      apiKey: undefined,
      webhookId: undefined,
      expectedWebhookUrl: undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch
    });
    expect(result).toEqual({ status: "disabled", addressCount: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a webhook that points to a different endpoint", async () => {
    const { db, fetchImpl } = setup({
      current: { ...current, webhookURL: "https://attacker.example/webhook" }
    });
    const list = await import("../../packages/database/src/index");
    const listSpy = vi.spyOn(list, "listHeliusMonitoredAddresses").mockResolvedValue(addresses);
    try {
      await expect(reconcileHeliusWebhookAddresses(db, {
        apiKey: "test-api-key",
        webhookId: "webhook-id",
        expectedWebhookUrl: "https://paylore.netlify.app/api/webhooks/helius",
        fetchImpl
      })).rejects.toThrow("HELIUS_WEBHOOK_CONFIGURATION_MISMATCH");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      listSpy.mockRestore();
    }
  });

  it("fails closed when Helius rejects the update", async () => {
    const { db, fetchImpl } = setup({ putStatus: 503 });
    const list = await import("../../packages/database/src/index");
    const listSpy = vi.spyOn(list, "listHeliusMonitoredAddresses").mockResolvedValue(addresses);
    try {
      await expect(reconcileHeliusWebhookAddresses(db, {
        apiKey: "test-api-key",
        webhookId: "webhook-id",
        expectedWebhookUrl: "https://paylore.netlify.app/api/webhooks/helius",
        fetchImpl
      })).rejects.toThrow("HELIUS_WEBHOOK_UPDATE_FAILED_503");
    } finally {
      listSpy.mockRestore();
    }
  });
});
