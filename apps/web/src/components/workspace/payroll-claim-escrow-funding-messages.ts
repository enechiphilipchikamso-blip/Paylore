import type { PayrollClaimEscrowFundingStage } from "../../server/solana/payroll-confidential-settlement";

/**
 * What a not-yet-finished Claim escrow funding is waiting for, by the step it stopped at.
 * Each text names the real state and what the next Check funding does, so an
 * administrator is never left with an unexplained "pending".
 */
const STAGE_MESSAGES: Record<PayrollClaimEscrowFundingStage, string> = {
  claim_settlement_in_progress:
    "A contributor claim for this allocation is being settled. Funding stays blocked until that claim transaction is verified; it is not a funding problem.",
  funding_in_progress:
    "Another funding request for this allocation started moments ago and may still be running. Check funding again shortly; once it is no longer running, Paylore completes or rolls it back and releases the hold.",
  proof_setup_unconfirmed:
    "The proof-setup transaction was submitted but the network has not confirmed it yet. No transfer has been sent. Check funding to continue from it.",
  transfer_unconfirmed:
    "The funding transfer was submitted and is waiting for network finality. Check funding to verify it; do not start another transfer.",
  transfer_outcome_unknown:
    "The funding transfer was sent but its result could not be read. Check funding to verify it on-chain; do not start another transfer.",
  balances_unverified:
    "The transfer is confirmed, but the reserve and escrow balances could not be read yet to verify the exact amount. Check funding again to finish verifying it.",
  proof_cleanup_pending:
    "The escrow is funded. Closing the temporary proof accounts is still pending, so the hold on this allocation stays until it completes. Check funding to finish.",
  lock_release_pending:
    "The escrow is funded, but releasing the hold on this allocation did not complete. Check funding to release it.",
  rollback_cleanup_pending:
    "Funding did not go through and no funds moved. Closing the temporary proof accounts is still pending, so the hold on this allocation stays until it completes. Check funding to finish, then fund the claim escrow again.",
  rollback_release_pending:
    "Funding did not go through and no funds moved, but releasing the hold on this allocation did not complete. Check funding to release it, then fund the claim escrow again."
};

const GENERIC_PENDING_MESSAGE =
  "Escrow funding has not finished. Check funding to verify the existing operation; do not start another transfer.";

export function describeFundingPending(stage: string | undefined, signature?: string): string {
  const text = (stage && (STAGE_MESSAGES as Record<string, string>)[stage]) || GENERIC_PENDING_MESSAGE;
  return signature ? `${text} Transaction: ${signature}` : text;
}
