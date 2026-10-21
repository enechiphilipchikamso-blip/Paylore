import { listHeliusMonitoredAddresses, type Database } from "../../packages/database/src/index";

type HeliusWebhook = {
  webhookID?: unknown;
  webhookURL?: unknown;
  transactionTypes?: unknown;
  accountAddresses?: unknown;
  webhookType?: unknown;
  authHeader?: unknown;
  txnStatus?: unknown;
};

function webhookUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.pathname === "/api/webhooks/helius";
  } catch {
    return false;
  }
}

export async function reconcileHeliusWebhookAddresses(
  db: Database,
  input: {
    apiKey: string | undefined;
    webhookId: string | undefined;
    expectedWebhookUrl: string | undefined;
    fetchImpl?: typeof fetch;
    listAddresses?: (db: Database) => Promise<string[]>;
  }
): Promise<{ status: "disabled" | "unchanged" | "updated"; addressCount: number }> {
  if (!input.apiKey || !input.webhookId || !input.expectedWebhookUrl) {
    return { status: "disabled", addressCount: 0 };
  }
  let expectedUrl: URL;
  try {
    expectedUrl = new URL(input.expectedWebhookUrl);
  } catch {
    throw new Error("HELIUS_WEBHOOK_URL_INVALID");
  }
  if (expectedUrl.protocol !== "https:" || expectedUrl.pathname !== "/api/webhooks/helius") {
    throw new Error("HELIUS_WEBHOOK_URL_INVALID");
  }

  const addresses = await (input.listAddresses ?? listHeliusMonitoredAddresses)(db);
  const fetchImpl = input.fetchImpl ?? fetch;
  const endpoint = "https://api.helius.xyz/v0/webhooks/" +
    encodeURIComponent(input.webhookId) + "?api-key=" + encodeURIComponent(input.apiKey);
  const currentResponse = await fetchImpl(endpoint, {
    method: "GET",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000)
  });
  if (!currentResponse.ok) {
    throw new Error("HELIUS_WEBHOOK_READ_FAILED_" + currentResponse.status);
  }
  const current = await currentResponse.json() as HeliusWebhook;
  if (current.webhookID !== input.webhookId || !webhookUrl(current.webhookURL) ||
      current.webhookURL !== expectedUrl.toString() ||
      !Array.isArray(current.transactionTypes) ||
      !current.transactionTypes.every((type) => typeof type === "string") ||
      typeof current.webhookType !== "string") {
    throw new Error("HELIUS_WEBHOOK_CONFIGURATION_MISMATCH");
  }
  const existing = Array.isArray(current.accountAddresses)
    ? current.accountAddresses.filter((address): address is string => typeof address === "string").sort()
    : [];
  if (existing.length === addresses.length &&
      existing.every((address, index) => address === addresses[index])) {
    return { status: "unchanged", addressCount: addresses.length };
  }

  const updateResponse = await fetchImpl(endpoint, {
    method: "PUT",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      webhookURL: current.webhookURL,
      transactionTypes: current.transactionTypes,
      accountAddresses: addresses,
      webhookType: current.webhookType,
      ...(typeof current.authHeader === "string" ? { authHeader: current.authHeader } : {}),
      ...(typeof current.txnStatus === "string" ? { txnStatus: current.txnStatus } : {})
    }),
    signal: AbortSignal.timeout(10_000)
  });
  if (!updateResponse.ok) {
    throw new Error("HELIUS_WEBHOOK_UPDATE_FAILED_" + updateResponse.status);
  }

  const updated = await updateResponse.json() as HeliusWebhook;
  const updatedAddresses = Array.isArray(updated.accountAddresses)
    ? updated.accountAddresses.filter((address): address is string => typeof address === "string").sort()
    : [];
  if (updated.webhookID !== input.webhookId ||
      updated.webhookURL !== expectedUrl.toString() ||
      updatedAddresses.length !== addresses.length ||
      !updatedAddresses.every((address, index) => address === addresses[index])) {
    throw new Error("HELIUS_WEBHOOK_UPDATE_NOT_RECONCILED");
  }
  return { status: "updated", addressCount: addresses.length };
}
