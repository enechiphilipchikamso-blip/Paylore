import { createSolanaRpc } from "@solana/kit";

export type SolanaWalletChain = `solana:${string}`;

export function createPayloreSolanaRpc() {
  return createSolanaRpc("/api/solana/rpc");
}

export function getPayloreWalletChain(): SolanaWalletChain {
  if (typeof document === "undefined") return "solana:devnet";
  const chain = document.body.dataset.payloreWalletChain;
  if (!chain) throw new Error("Paylore wallet network configuration is unavailable.");
  return chain as SolanaWalletChain;
}

export function solanaExplorerUrl(signature: string, cluster: string): string {
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}?cluster=${encodeURIComponent(cluster)}`;
}

export function getPayloreExplorerCluster(): string {
  const cluster = document.body.dataset.payloreExplorerCluster;
  if (!cluster) throw new Error("Paylore explorer network configuration is unavailable.");
  return cluster;
}
