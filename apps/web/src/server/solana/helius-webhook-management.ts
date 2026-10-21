import "server-only";

export const PAYLORE_HELIUS_WEBHOOK_URL =
  "https://paylore.netlify.app/api/webhooks/helius";
const WEBHOOKS_API_BASE = "https://api-mainnet.helius-rpc.com/v0/webhooks";
const MAX_MONITORED_ADDRESSES = 100_000;
const ADDRESS_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

type HeliusWebhook = {
  webhookID?: unknown;
  webhookURL?: unknown;
  webhookType?: unknown;
  accountAddresses?: unknown;
  transactionTypes?: unknown;
  authHeader?: unknown;
  encoding?: unknown;
  txnStatus?: unknown;
  active?: unknown;
};

export type HeliusWebhookSyncResult = {
  updated: boolean;
  reactivated: boolean;
  monitoredAddressCount: number;
};

export class HeliusWebhookManagementError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "HeliusWebhookManagementError";
  }
}

export function normalizeHeliusMonitoredAddresses(
  addresses: readonly string[]
): string[] {
  const unique = new Set<string>();
  for (const candidate of addresses) {
    if (!ADDRESS_PATTERN.test(candidate)) {
      throw new HeliusWebhookManagementError("invalid_monitored_address");
    }
    unique.add(candidate);
  }
  if (unique.size === 0) {
    throw new HeliusWebhookManagementError("monitored_address_set_empty");
  }
  if (unique.size > MAX_MONITORED_ADDRESSES) {
    throw new HeliusWebhookManagementError("monitored_address_limit_exceeded");
  }
  return [...unique].sort();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function webhookEndpoint(webhookId: string, apiKey: string): string {
  const url = new URL(`${WEBHOOKS_API_BASE}/${encodeURIComponent(webhookId)}`);
  url.searchParams.set("api-key", apiKey);
  return url.toString();
}

async function readWebhook(
  endpoint: string,
  fetcher: typeof fetch
): Promise<HeliusWebhook> {
  const response = await fetcher(endpoint, {
    method: "GET",
    headers: { accept: "application/json" },
    cache: "no-store"
  });
  if (!response.ok) {
    throw new HeliusWebhookManagementError(
      response.status === 404
        ? "helius_webhook_not_found"
        : `helius_webhook_read_failed_${response.status}`
    );
  }
  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new HeliusWebhookManagementError("helius_webhook_response_invalid");
  }
  if (!isRecord(value)) {
    throw new HeliusWebhookManagementError("helius_webhook_response_invalid");
  }
  return value as HeliusWebhook;
}

function sameAddressSet(current: unknown, desired: readonly string[]): boolean {
  if (
    !Array.isArray(current) ||
    !current.every((item): item is string => typeof item === "string")
  ) {
    return false;
  }
  const normalized = [...new Set(current)].sort();
  return normalized.length === desired.length &&
    normalized.every((item, index) => item === desired[index]);
}

function monitorsAllTransactionTypes(current: unknown): boolean {
  return Array.isArray(current) &&
    current.length === 1 &&
    current[0] === "ANY";
}

function matchesDesiredConfig(
  current: HeliusWebhook,
  addresses: readonly string[],
  authHeader: string
): boolean {
  return current.webhookURL === PAYLORE_HELIUS_WEBHOOK_URL &&
    current.webhookType === "enhancedDevnet" &&
    sameAddressSet(current.accountAddresses, addresses) &&
    monitorsAllTransactionTypes(current.transactionTypes) &&
    current.authHeader === authHeader;
}

/**
 * Read, reconcile, and read back the single existing Helius webhook. Empty
 * The explicit ANY transaction filter and enhancedDevnet type keep the webhook
 * aligned with the dashboard's all-transactions Devnet configuration.
 */
export async function reconcileHeliusWebhook(input: {
  managementApiKey: string;
  webhookId: string;
  webhookSecret: string;
  monitoredAddresses: readonly string[];
  fetcher?: typeof fetch;
}): Promise<HeliusWebhookSyncResult> {
  const apiKey = input.managementApiKey.trim();
  const webhookId = input.webhookId.trim();
  const secret = input.webhookSecret.trim();
  if (!apiKey || !webhookId || !secret) {
    throw new HeliusWebhookManagementError("helius_management_config_incomplete");
  }

  const addresses = normalizeHeliusMonitoredAddresses(input.monitoredAddresses);
  const authHeader = `Bearer ${secret}`;
  const fetcher = input.fetcher ?? fetch;
  const endpoint = webhookEndpoint(webhookId, apiKey);
  const current = await readWebhook(endpoint, fetcher);

  if (typeof current.webhookID === "string" && current.webhookID !== webhookId) {
    throw new HeliusWebhookManagementError("helius_webhook_id_mismatch");
  }

  const needsConfigUpdate = !matchesDesiredConfig(current, addresses, authHeader);
  if (needsConfigUpdate) {
    const body: Record<string, unknown> = {
      webhookURL: PAYLORE_HELIUS_WEBHOOK_URL,
      webhookType: "enhancedDevnet",
      accountAddresses: addresses,
      transactionTypes: ["ANY"],
      authHeader
    };
    if (typeof current.encoding === "string") body.encoding = current.encoding;
    if (typeof current.txnStatus === "string") body.txnStatus = current.txnStatus;

    const response = await fetcher(endpoint, {
      method: "PUT",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
      cache: "no-store"
    });
    if (!response.ok) {
      throw new HeliusWebhookManagementError(
        `helius_webhook_update_failed_${response.status}`
      );
    }
  }

  let after = needsConfigUpdate
    ? await readWebhook(endpoint, fetcher)
    : current;
  if (!matchesDesiredConfig(after, addresses, authHeader)) {
    throw new HeliusWebhookManagementError("helius_webhook_readback_mismatch");
  }

  let reactivated = false;
  if (after.active === false) {
    const response = await fetcher(endpoint, {
      method: "PATCH",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ active: true }),
      cache: "no-store"
    });
    if (!response.ok) {
      throw new HeliusWebhookManagementError(
        `helius_webhook_reactivation_failed_${response.status}`
      );
    }
    after = await readWebhook(endpoint, fetcher);
    if (after.active === false) {
      throw new HeliusWebhookManagementError("helius_webhook_reactivation_not_confirmed");
    }
    reactivated = true;
  }

  return {
    updated: needsConfigUpdate,
    reactivated,
    monitoredAddressCount: addresses.length
  };
}
