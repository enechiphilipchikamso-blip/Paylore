import { signature } from "@solana/kit";
import { createPayloreSolanaRpc } from "./solana-network";

const FINALITY_TIMEOUT_MS = 120_000;

export async function waitForSolanaFinality(transactionSignature: string) {
  const rpc = createPayloreSolanaRpc();
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
      throw new Error("The Solana transaction failed.");
    }
    if (status?.confirmationStatus === "finalized") return;
    await new Promise((resolve) => window.setTimeout(resolve, 1_000));
  }
  throw new Error(
    `The transaction was submitted but is not finalized yet: ${transactionSignature}`
  );
}
