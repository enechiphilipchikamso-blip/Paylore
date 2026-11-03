import { createSolanaRpc, signature } from "@solana/kit";

const DEVNET_RPC_URL = "https://api.devnet.solana.com";
const FINALITY_TIMEOUT_MS = 120_000;

export async function waitForDevnetFinality(transactionSignature: string) {
  const rpc = createSolanaRpc(DEVNET_RPC_URL);
  const expectedSignature = signature(transactionSignature);
  const deadline = Date.now() + FINALITY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await rpc
      .getSignatureStatuses([expectedSignature], {
        searchTransactionHistory: true
      })
      .send();
    const status = result.value[0];
    if (status?.err) {
      throw new Error("The Devnet transaction failed on Solana.");
    }
    if (status?.confirmationStatus === "finalized") return;
    await new Promise((resolve) => window.setTimeout(resolve, 1_000));
  }
  throw new Error(
    `The transaction was submitted but is not finalized yet: ${transactionSignature}`
  );
}
