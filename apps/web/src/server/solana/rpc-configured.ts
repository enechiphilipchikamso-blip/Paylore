import { loadPayloreConfig } from "../config";
import { readSolanaRpcWithProviders } from "./rpc-core";

export { SolanaRpcError } from "./rpc-core";

function configuredProviders() {
  const config = loadPayloreConfig();
  const providers = [{
    name: config.PAYLORE_RPC_PRIMARY_PROVIDER,
    url: config.PAYLORE_RPC_PRIMARY_URL,
    apiKey: config.PAYLORE_RPC_PRIMARY_API_KEY
  }];

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

export async function readSolanaRpc<T>(
  method: string,
  params: readonly unknown[] = []
): Promise<T> {
  return readSolanaRpcWithProviders(
    method,
    params,
    configuredProviders()
  );
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
