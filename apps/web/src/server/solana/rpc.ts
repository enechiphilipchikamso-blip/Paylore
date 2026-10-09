import "server-only";

import { loadPayloreConfig } from "../config";

const READ_ONLY_METHODS = new Set([
  "getAccountInfo",
  "getBalance",
  "getLatestBlockhash",
  "getSignatureStatuses",
  "getSlot",
  "getTokenAccountsByOwner",
  "getTransaction"
]);

type RpcProvider = {
  name: string;
  url: string;
  apiKey?: string;
};

export class SolanaRpcError extends Error {
  constructor(
    message: string,
    readonly provider?: string
  ) {
    super(message);
    this.name = "SolanaRpcError";
  }
}

function configuredProviders(): RpcProvider[] {
  const config = loadPayloreConfig();
  const providers: RpcProvider[] = [
    {
      name: config.PAYLORE_RPC_PRIMARY_PROVIDER,
      url: config.PAYLORE_RPC_PRIMARY_URL,
      apiKey: config.PAYLORE_RPC_PRIMARY_API_KEY
    }
  ];

  if (
    config.PAYLORE_RPC_SECONDARY_URL &&
    config.PAYLORE_RPC_SECONDARY_PROVIDER
  ) {
    providers.push({
      name: config.PAYLORE_RPC_SECONDARY_PROVIDER,
      url: config.PAYLORE_RPC_SECONDARY_URL,
      apiKey: config.PAYLORE_RPC_SECONDARY_API_KEY
    });
  }

  return providers;
}

function requestUrl(provider: RpcProvider): URL {
  const url = new URL(provider.url);
  if (provider.name === "helius" && provider.apiKey) {
    url.searchParams.set("api-key", provider.apiKey);
  }
  return url;
}

async function requestProvider<T>(
  provider: RpcProvider,
  method: string,
  params: readonly unknown[]
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);

  try {
    const headers: Record<string, string> = {
      "content-type": "application/json"
    };
    if (provider.apiKey && provider.name !== "helius") {
      headers["x-api-key"] = provider.apiKey;
    }

    const response = await fetch(requestUrl(provider), {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: crypto.randomUUID(),
        method,
        params
      }),
      cache: "no-store",
      signal: controller.signal
    });

    if (!response.ok) {
      throw new SolanaRpcError(
        response.status === 429 || response.status >= 500
          ? "The Solana provider is temporarily unavailable."
          : "The Solana provider rejected the request.",
        provider.name
      );
    }

    const envelope: unknown = await response.json();
    if (
      !envelope ||
      typeof envelope !== "object" ||
      !("result" in envelope)
    ) {
      throw new SolanaRpcError(
        "The Solana provider returned an invalid response.",
        provider.name
      );
    }

    if ("error" in envelope && envelope.error) {
      throw new SolanaRpcError(
        "The Solana provider could not complete the request.",
        provider.name
      );
    }

    return envelope.result as T;
  } catch (error) {
    if (error instanceof SolanaRpcError) {
      throw error;
    }
    throw new SolanaRpcError(
      "The Solana provider could not be reached.",
      provider.name
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function readSolanaRpc<T>(
  method: string,
  params: readonly unknown[] = []
): Promise<T> {
  if (!READ_ONLY_METHODS.has(method)) {
    throw new SolanaRpcError(
      "Only approved read-only Solana RPC methods are available."
    );
  }

  const providers = configuredProviders();
  let lastError: SolanaRpcError | undefined;

  for (const [index, provider] of providers.entries()) {
    try {
      return await requestProvider<T>(provider, method, params);
    } catch (error) {
      if (!(error instanceof SolanaRpcError)) {
        throw error;
      }
      lastError = error;
      const hasFallback = index < providers.length - 1;
      if (!hasFallback) {
        throw error;
      }
    }
  }

  throw lastError ??
    new SolanaRpcError("No Solana RPC provider is configured.");
}

export async function getDevnetHealth() {
  const slot = await readSolanaRpc<number>("getSlot", [
    { commitment: "finalized" }
  ]);
  return {
    network: "devnet" as const,
    slot
  };
}
