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
  let persisted = options.current ?? current;
  const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === "PUT") {
      persisted = options.updated ?? {
        ...persisted,
        accountAddresses: addresses
      };
      return new Response(JSON.stringify(persisted), { status: options.putStatus ?? 200 });
    }
    return new Response(JSON.stringify(persisted), {
      status: options.getStatus ?? 200
    });
  }) as unknown as typeof fetch;
  const db = {} as never;
  return { db, fetchImpl };
}

describe("dynamic Helius webhook address reconciliation", () => {
  it("updates only the monitored address set and reads back the result", async () => {
    const { db, fetchImpl } = setup();
    try {
      const result = await reconcileHeliusWebhookAddresses(db, {
        apiKey: "test-api-key",
        webhookId: "webhook-id",
        expectedWebhookUrl: "https://paylore.netlify.app/api/webhooks/helius",
        fetchImpl,
        listAddresses: async () => addresses
      });
      expect(result).toEqual({ status: "updated", addressCount: 2 });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      const update = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[1][1] as RequestInit;
      expect(JSON.parse(String(update.body))).toMatchObject({
        webhookURL: current.webhookURL,
        transactionTypes: current.transactionTypes,
        accountAddresses: addresses,
        webhookType: current.webhookType,
        authHeader: current.authHeader
      });
    } finally {
      // Keep the test structure symmetrical with external-resource cleanup.
    }
  });

  it("does not call Helius when management is not configured", async () => {
    const fetchImpl = vi.fn();
    const result = await reconcileHeliusWebhookAddresses({} as never, {
      apiKey: undefined,
      webhookId: undefined,
      expectedWebhookUrl: undefined,
      fetchImpl: fetchImpl as unknown as typeof fetch,
      listAddresses: async () => addresses
    });
    expect(result).toEqual({ status: "disabled", addressCount: 0 });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("rejects a webhook that points to a different endpoint", async () => {
    const { db, fetchImpl } = setup({
      current: { ...current, webhookURL: "https://attacker.example/webhook" }
    });
    try {
      await expect(reconcileHeliusWebhookAddresses(db, {
        apiKey: "test-api-key",
        webhookId: "webhook-id",
        expectedWebhookUrl: "https://paylore.netlify.app/api/webhooks/helius",
        fetchImpl,
        listAddresses: async () => addresses
      })).rejects.toThrow("HELIUS_WEBHOOK_CONFIGURATION_MISMATCH");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      // No network resources are retained by the mocked fetch implementation.
    }
  });

  it("fails closed when Helius rejects the update", async () => {
    const { db, fetchImpl } = setup({ putStatus: 503 });
    try {
      await expect(reconcileHeliusWebhookAddresses(db, {
        apiKey: "test-api-key",
        webhookId: "webhook-id",
        expectedWebhookUrl: "https://paylore.netlify.app/api/webhooks/helius",
        fetchImpl,
        listAddresses: async () => addresses
      })).rejects.toThrow("HELIUS_WEBHOOK_UPDATE_FAILED_503");
    } finally {
      // No network resources are retained by the mocked fetch implementation.
    }
  });
});
