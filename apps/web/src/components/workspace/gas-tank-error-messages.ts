/**
 * Translates server error codes from Gas Tank–sponsored workspace operations
 * into actionable messages. Unknown codes are still surfaced (as a reference)
 * so a failure is never hidden behind a generic fallback.
 */
const GAS_TANK_ERROR_MESSAGES: Record<string, string> = {
  gas_tank_not_initialized:
    "The workspace Gas Tank has not been initialized. Set it up on the Gas Tank page, fund it with SOL, then retry.",
  gas_tank_insufficient_balance:
    "The workspace Gas Tank balance is too low for this operation's network fees and account rent. Fund the Gas Tank, then retry.",
  gas_tank_daily_sponsorship_limit:
    "The workspace Gas Tank sponsorship limit for the last 24 hours has been reached. Retry after the budget window resets.",
  gas_tank_key_identity_mismatch:
    "The stored Gas Tank signing key does not match the Gas Tank address. Paylore stopped before signing anything.",
  gas_tank_operation_preparing:
    "Another request is preparing a Gas Tank transaction for this same batch. Wait a minute, then retry.",
  gas_tank_operation_already_prepared:
    "An earlier sponsored attempt exists for this batch. Refresh and retry so Paylore can reconcile that attempt first.",
  gas_tank_operation_already_finalized:
    "An earlier sponsored attempt for this batch is already finalized. Refresh to view the recorded state.",
  gas_tank_sponsorship_failed:
    "The Gas Tank service failed unexpectedly while preparing the transaction. Nothing was signed. Retry; if it persists, check the Gas Tank page.",
  sponsored_simulation_failed:
    "The sponsored transaction failed its pre-flight simulation on Solana. Nothing was signed or submitted.",
  sponsored_simulation_unavailable:
    "The Solana network could not simulate the sponsored transaction right now. Nothing was signed. Retry shortly.",
  sponsored_fee_unavailable:
    "The Solana network did not return a network fee quote. Nothing was signed. Retry shortly.",
  sponsored_rent_unavailable:
    "The Solana network did not return an account rent quote. Nothing was signed. Retry shortly.",
  sponsored_fee_limit_exceeded:
    "The quoted network fee exceeds the Gas Tank per-operation limit. Nothing was signed.",
  sponsored_compute_limit_exceeded:
    "The transaction exceeds the Gas Tank compute limit. Nothing was signed.",
  sponsored_transaction_size_exceeded:
    "The transaction is too large for a single sponsored submission. Nothing was signed.",
  sponsored_claim_already_exists:
    "A Claim PDA for this batch already exists on-chain. Refresh the payroll run to reconcile it.",
  sponsored_claim_state_unavailable:
    "The Solana network did not return the current Claim PDA state. Nothing was signed. Retry shortly.",
  sponsored_workspace_pda_owner_mismatch:
    "The on-chain workspace account is not owned by the configured Payroll Program. Check the configured program ID.",
  sponsored_claim_allocation_not_eligible:
    "One or more allocations are no longer eligible for Claim PDA creation. Refresh the payroll run.",
  sponsorship_idempotency_conflict:
    "An earlier sponsored attempt for this batch used different parameters. Refresh the payroll run before retrying.",
  sponsorship_operation_state_changed:
    "The sponsored attempt changed state while it was being processed. Refresh and retry.",
  sponsorship_operation_reconciliation_conflict:
    "The earlier sponsored transaction could not be matched to this payroll batch. Do not retry until the run is reviewed.",
  sponsorship_operation_reconciliation_data_missing:
    "The earlier sponsored attempt is missing its reconciliation data. Do not retry until the run is reviewed.",
  sponsorship_finalized_transaction_verification_failed:
    "The earlier finalized transaction could not be verified against this payroll batch yet. Retry shortly.",
  sponsorship_failed_transaction_fee_unavailable:
    "The earlier transaction failed on-chain, and the Solana network has not returned its actual fee yet. Retry shortly.",
  sponsorship_transaction_pending_finality:
    "An earlier sponsored transaction was submitted and is awaiting finality. Paylore will not create another transaction until it resolves.",
  sponsorship_transaction_still_live:
    "A prepared Gas Tank transaction is still valid. Do not approve another transaction until the existing attempt is reconciled.",
  previous_sponsored_transaction_failed_retry_allowed:
    "The earlier sponsored transaction finalized with an on-chain failure. Its actual network fee was recorded; you can safely retry the same batch.",
  payroll_run_already_committed:
    "This payroll run is already committed. Refresh to view its recorded state.",
  payroll_run_not_confirmed:
    "This payroll run is not manager-confirmed with an allocation commitment.",
  payroll_program_not_configured:
    "The Paylore Payroll Program is not configured for this deployment.",
  payroll_mint_not_configured:
    "The wrapped-USDC mint is not configured for this deployment.",
  workspace_read_only:
    "The workspace subscription is not active, so sponsored operations are paused. Renew the workspace, then retry.",
  workspace_deletion_pending:
    "This workspace is scheduled for deletion, so sponsored operations are paused.",
  workspace_access_denied:
    "Only the workspace administrator wallet can request this sponsored operation.",
  authentication_required:
    "Your Paylore session has ended. Sign in again, then retry.",
  request_not_allowed:
    "The request was rejected by Paylore's origin check. Reload the page and retry.",
  payroll_claim_escrow_setup_pending:
    "Paylore is still finalizing the confidential allocation accounts on Solana. Retry in a few seconds.",
  payroll_claim_escrow_allocation_invalid:
    "An allocation is not in a state that allows its confidential allocation account to be prepared. Refresh the payroll run.",
  payroll_claim_escrow_amount_invalid:
    "An allocation amount is invalid for confidential settlement.",
  payroll_claim_escrow_identity_conflict:
    "An allocation account record conflicts with this payroll run. Refresh the payroll run before retrying.",
  payroll_claim_escrow_not_persisted:
    "The confidential allocation account could not be recorded. Retry shortly.",
  payroll_claim_escrow_key_unavailable:
    "The confidential allocation account key is unavailable on the server.",
  payroll_claim_escrow_key_mismatch:
    "The stored confidential allocation account key does not match its address.",
  payroll_program_identity_mismatch:
    "The configured Payroll Program changed during preparation. Reload the page and retry.",
  reserve_envelope_key_not_configured:
    "Server key custody for confidential accounts is not configured for this deployment.",
  payroll_claim_escrow_mint_invalid:
    "The configured wrapped-USDC mint does not use 6 decimals.",
  payroll_claim_escrow_mint_not_approved:
    "The wrapped-USDC mint does not auto-approve confidential accounts.",
  payroll_claim_escrow_account_setup_failed:
    "Creating a confidential allocation account failed on-chain. Its fee was paid by the Gas Tank; you can retry.",
  payroll_claim_escrow_confidential_setup_failed:
    "Configuring a confidential allocation account failed on-chain. You can retry.",
  payroll_claim_escrow_account_owner_invalid:
    "An existing allocation account is not a Token-2022 account.",
  payroll_claim_escrow_account_identity_invalid:
    "An existing allocation account is not owned by the workspace Reserve.",
  payroll_claim_escrow_state_conflict:
    "An allocation account changed state during preparation. Refresh and retry.",
  confidential_setup_sponsorship_unavailable:
    "Company-sponsored account setup is unavailable right now. Paylore did not fall back to charging your wallet. Retry shortly.",
  confidential_setup_sponsorship_pending:
    "An earlier sponsored account setup is still awaiting finality. Wait for it to finish before retrying.",
  confidential_setup_sponsorship_conflict:
    "A different sponsored account setup is already in progress for this wallet.",
  confidential_setup_blockhash_expired:
    "The sponsored account setup expired before submission. Retry to prepare a fresh transaction.",
  confidential_setup_transaction_failed:
    "The sponsored account setup failed on-chain. You can retry.",
  confidential_account_already_ready:
    "Your confidential account is already set up.",
  workspace_busy:
    "Another payroll claim or recovery is being reconciled for this workspace. Retry after it finishes.",
  workspace_reserve_not_initialized:
    "The workspace confidential Reserve is not initialized.",
  workspace_reserve_key_mismatch:
    "The stored Reserve signing key does not match the Reserve address.",
  reserve_confidential_balance_insufficient:
    "The workspace Reserve does not hold enough available confidential USDC for this allocation.",
  reserve_account_requires_mint_authority_approval:
    "The workspace Reserve account still needs mint-authority approval for confidential transfers.",
  reserve_pending_balance_apply_failed:
    "Applying the Reserve's pending confidential balance failed on-chain. Retry shortly.",
  reserve_pending_balance_unreconciled:
    "The Reserve's pending confidential balance has not been reconciled yet. Retry shortly.",
  payroll_claim_escrow_not_found:
    "The confidential allocation account for this payroll entry was not found.",
  payroll_claim_escrow_not_ready:
    "The confidential allocation account for this payroll entry is not ready yet.",
  payroll_claim_escrow_balance_not_ready:
    "The confidential allocation account balance is not ready yet. Retry shortly.",
  payroll_claim_escrow_funding_failed:
    "Funding the confidential allocation account failed on-chain. Retry shortly.",
  payroll_claim_escrow_funding_conflict:
    "The confidential allocation account funding conflicts with an earlier attempt.",
  payroll_allocation_not_recoverable:
    "This allocation is no longer eligible for recovery.",
  payroll_recovery_state_conflict:
    "The allocation changed state during recovery. Refresh before retrying."
};

/** Codes a contributor cannot resolve; a workspace administrator must act. */
const ADMINISTRATOR_ACTION_CODES = new Set([
  "gas_tank_not_initialized",
  "gas_tank_insufficient_balance",
  "gas_tank_daily_sponsorship_limit",
  "workspace_read_only",
  "workspace_reserve_not_initialized",
  "reserve_confidential_balance_insufficient",
  "reserve_account_requires_mint_authority_approval"
]);

/** Contributor-facing wording: fees are company-sponsored and Paylore never charges the contributor wallet instead. */
export function describeContributorSponsoredError(
  code: string | null | undefined,
  httpStatus?: number
): string {
  if (code === "gas_tank_insufficient_balance") {
    return "The workspace Gas Tank needs SOL before this company-sponsored step can run. Ask a workspace administrator to fund it; Paylore will not charge your wallet instead.";
  }
  if (code === "gas_tank_not_initialized") {
    return "The workspace Gas Tank is not set up yet. Ask a workspace administrator to set it up; Paylore will not charge your wallet instead.";
  }
  const text = describeGasTankError(code, httpStatus);
  return code && ADMINISTRATOR_ACTION_CODES.has(code)
    ? `${text} Ask a workspace administrator to resolve this.`
    : text;
}

/** Codes that mean "the same request will succeed shortly"; callers may retry automatically. */
export const GAS_TANK_RETRYABLE_PENDING_CODES = new Set([
  "payroll_claim_escrow_setup_pending"
]);

export function describeGasTankError(
  code: string | null | undefined,
  httpStatus?: number
): string {
  if (code && GAS_TANK_ERROR_MESSAGES[code]) return GAS_TANK_ERROR_MESSAGES[code];
  if (!code) {
    if (httpStatus === 502 || httpStatus === 504) {
      return "The Paylore server timed out while waiting for the Solana network. Anything already submitted was recorded; retry to continue from where it stopped.";
    }
    return httpStatus
      ? `Paylore returned an unreadable response (HTTP ${httpStatus}). Nothing was signed by your wallet. Retry shortly.`
      : "Paylore could not be reached. Check your connection and retry.";
  }
  return `The Gas Tank operation was rejected (reference: ${code}). Nothing was signed by your wallet.`;
}
