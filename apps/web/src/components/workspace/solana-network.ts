/**
 * Public, network-independent Solana settings for browser code. The network is resolved
 * from PAYLORE_NETWORK at build time (see next.config.ts); RPC traffic goes through the
 * same-origin relay so provider URLs and keys stay on the server.
 */
export type SolanaNetwork = "devnet" | "mainnet";

export const SOLANA_NETWORK: SolanaNetwork =
  process.env.NEXT_PUBLIC_PAYLORE_NETWORK === "mainnet" ? "mainnet" : "devnet";

export const SOLANA_WALLET_CHAIN: `solana:${string}` = `solana:${SOLANA_NETWORK}`;

export function browserSolanaRpcUrl(): string {
  const origin = typeof window === "undefined" ? "http://localhost" : window.location.origin;
  return `${origin}/api/solana/rpc`;
}

export function solanaExplorerTransactionUrl(signature: string): string {
  const url = `https://explorer.solana.com/tx/${encodeURIComponent(signature)}`;
  return SOLANA_NETWORK === "mainnet" ? url : `${url}?cluster=${SOLANA_NETWORK}`;
}
