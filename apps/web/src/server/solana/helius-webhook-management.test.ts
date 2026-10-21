import { describe, expect, it, vi } from "vitest";
import {
  HeliusWebhookManagementError,
  PAYLORE_HELIUS_WEBHOOK_URL,
  normalizeHeliusMonitoredAddresses,
  reconcileHeliusWebhook
} from "./helius-webhook-management";

const webhookId = "existing-devnet-webhook";
const apiKey = "test-management-api-key";
const secret = "test-shared-secret";
const program = "11111111111111111111111111111111";
const reserve = "22222222222222222222222222222222";
const baseWebhook = {
  webhookID: webhookId,
  webhookURL: PAYLORE_HELIUS_WEBHOOK_URL,
  webhookType: "enhancedDevnet",
  accountAddresses: [program, reserve],
  transactionTypes: [],
  authHeader: `Bearer ${secret}`,
  encoding: "jsonParsed",
  txnStatus: "all",
  active: true
};

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}

describe("Helius webhook reconciliation", () => {
  it("deduplicates and sorts the authoritative monitored address set", () => {
    expect(normalizeHeliusMonitoredAddresses([reserve, program, reserve])).toEqual([
      program,
      reserve
    ]);
  });

  it("does not issue a mutation when the read-back configuration already matches", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response(baseWebhook));
    const result = await reconcileHeliusWebhook({
      managementApiKey: apiKey,
      webhookId,
      webhookSecret: secret,
      monitoredAddresses: [reserve, program],
      fetcher
    });

    expect(result).toEqual({
      updated: false,
      reactivated: false,
      monitoredAddressCount: 2
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher.mock.calls[0][1]?.method).toBe("GET");
    expect(String(fetcher.mock.calls[0][0])).toContain("api-key=test-management-api-key");
  });

  it("updates a changed dynamic address set and verifies the provider read-back", async () => {
    const old = { ...baseWebhook, accountAddresses: [program] };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(old))
      .mockResolvedValueOnce(response({ ok: true }))
      .mockResolvedValueOnce(response({
        ...baseWebhook,
        accountAddresses: [program, reserve]
      }));

    const result = await reconcileHeliusWebhook({
      managementApiKey: apiKey,
      webhookId,
      webhookSecret: secret,
      monitoredAddresses: [program, reserve],
      fetcher
    });

    expect(result.updated).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[1][1]?.method).toBe("PUT");
    const body = JSON.parse(String(fetcher.mock.calls[1][1]?.body)) as Record<string, unknown>;
    expect(body.accountAddresses).toEqual([program, reserve]);
    expect(body.webhookURL).toBe(PAYLORE_HELIUS_WEBHOOK_URL);
    expect(body.webhookType).toBe("enhancedDevnet");
    expect(body.transactionTypes).toEqual([]);
    expect(body.authHeader).toBe(`Bearer ${secret}`);
    expect(body.encoding).toBe("jsonParsed");
    expect(body.txnStatus).toBe("all");
  });

  it("reactivates a disabled webhook and verifies its state", async () => {
    const disabled = { ...baseWebhook, active: false };
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response(disabled))
      .mockResolvedValueOnce(response({ ...baseWebhook, active: true }))
      .mockResolvedValueOnce(response({ ...baseWebhook, active: true }));

    const result = await reconcileHeliusWebhook({
      managementApiKey: apiKey,
      webhookId,
      webhookSecret: secret,
      monitoredAddresses: [program, reserve],
      fetcher
    });

    expect(result.reactivated).toBe(true);
    expect(fetcher).toHaveBeenCalledTimes(3);
    expect(fetcher.mock.calls[1][1]?.method).toBe("PATCH");
    expect(fetcher.mock.calls[1][1]?.body).toBe(JSON.stringify({ active: true }));
  });

  it("fails closed if provider read-back does not match the desired set", async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(response({ ...baseWebhook, accountAddresses: [program] }))
      .mockResolvedValueOnce(response({ ok: true }))
      .mockResolvedValueOnce(response({ ...baseWebhook, accountAddresses: [program] }));

    await expect(reconcileHeliusWebhook({
      managementApiKey: apiKey,
      webhookId,
      webhookSecret: secret,
      monitoredAddresses: [program, reserve],
      fetcher
    })).rejects.toMatchObject({
      code: "helius_webhook_readback_mismatch"
    });
  });

  it("does not update when the webhook resource is missing", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(response({ message: "not found" }, 404));
    await expect(reconcileHeliusWebhook({
      managementApiKey: apiKey,
      webhookId,
      webhookSecret: secret,
      monitoredAddresses: [program, reserve],
      fetcher
    })).rejects.toMatchObject({
      code: "helius_webhook_not_found"
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects malformed addresses rather than truncating the address set", () => {
    expect(() => normalizeHeliusMonitoredAddresses([program, "not-an-address"]))
      .toThrow(HeliusWebhookManagementError);
  });
});
