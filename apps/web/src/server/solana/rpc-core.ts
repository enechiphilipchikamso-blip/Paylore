export type SolanaRpcProvider = {
  name: string;
  url: string;
  apiKey?: string;
};

/**
 * Every JSON-RPC method the server issues. Transaction-bearing methods are listed only
 * because each caller submits a transaction it built and validated itself; the Gas Tank
 * never forwards arbitrary client transactions through this helper.
 */
const APPROVED_METHODS = new Set([
  "getAccountInfo",
  "getBalance",
  "getBlockHeight",
  "getFeeForMessage",
  "getLatestBlockhash",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getSignaturesForAddress",
  "getSignatureStatuses",
  "getSlot",
  "getTokenAccountBalance",
  "getTokenAccountsByOwner",
  "getTokenSupply",
  "getTransaction",
  "isBlockhashValid",
  "sendTransaction",
  "simulateTransaction"
]);

export type SolanaRpcErrorDetail = { code: number; message: string; data?: unknown };

export class SolanaRpcError extends Error {
  constructor(
    message: string,
    readonly provider?: string,
    /** The provider's JSON-RPC error object, when the provider answered with one. */
    readonly rpcError?: SolanaRpcErrorDetail
  ) {
    super(message);
    this.name = "SolanaRpcError";
  }
}

function requestUrl(provider: SolanaRpcProvider): URL {
  const url = new URL(provider.url);
  if (provider.name === "helius" && provider.apiKey) {
    url.searchParams.set("api-key", provider.apiKey);
  }
  return url;
}

async function requestProvider<T>(
  provider: SolanaRpcProvider,
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
    if (!envelope || typeof envelope !== "object") {
      throw new SolanaRpcError(
        "The Solana provider returned an invalid response.",
        provider.name
      );
    }
    if ("error" in envelope && envelope.error) {
      const detail = envelope.error as Partial<SolanaRpcErrorDetail>;
      throw new SolanaRpcError(
        "The Solana provider could not complete the request.",
        provider.name,
        typeof detail.code === "number" && typeof detail.message === "string"
          ? { code: detail.code, message: detail.message, data: detail.data }
          : undefined
      );
    }
    if (!("result" in envelope)) {
      throw new SolanaRpcError(
        "The Solana provider returned an invalid response.",
        provider.name
      );
    }
    return envelope.result as T;
  } catch (error) {
    if (error instanceof SolanaRpcError) throw error;
    throw new SolanaRpcError(
      "The Solana provider could not be reached.",
      provider.name
    );
  } finally {
    clearTimeout(timeout);
  }
}

export async function readSolanaRpcWithProviders<T>(
  method: string,
  params: readonly unknown[],
  providers: readonly SolanaRpcProvider[]
): Promise<T> {
  if (!APPROVED_METHODS.has(method)) {
    throw new SolanaRpcError(
      "Only approved Solana RPC methods are available."
    );
  }
  if (providers.length === 0) {
    throw new SolanaRpcError("No Solana RPC provider is configured.");
  }

  let lastError: SolanaRpcError | undefined;
  for (const [index, provider] of providers.entries()) {
    try {
      return await requestProvider<T>(provider, method, params);
    } catch (error) {
      if (!(error instanceof SolanaRpcError)) throw error;
      lastError = error;
      if (error.rpcError || index === providers.length - 1) throw error;
    }
  }
  throw lastError ?? new SolanaRpcError("No Solana RPC provider is configured.");
}
