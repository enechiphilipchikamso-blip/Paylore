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
    "Funding the confidential allocation account did not complete. Paylore released the attempt and no funding is recorded, so it is safe to retry. If it repeats, the server log carries the exact cause.",
  payroll_claim_escrow_funding_conflict:
    "The confidential allocation account funding conflicts with an earlier attempt.",
  payroll_claim_creation_unverified:
    "The finalized Claim PDA creation transaction could not be verified against this allocation.",
  payroll_claim_state_conflict:
    "The allocation is already being claimed or recovered. Refresh its finalized state before retrying.",
  payroll_allocation_commitment_invalid:
    "The allocation amount or commitment is invalid. No confidential transfer was submitted.",
  payroll_amount_commitment_not_configured:
    "Payroll amount-commitment verification is not configured for this deployment.",
  payroll_amount_commitment_mismatch:
    "The committed allocation amount does not match the stored payroll amount.",
  confidential_mint_unavailable:
    "The configured wrapped-USDC mint is unavailable or does not support confidential transfers.",
  reserve_program_configuration_failed:
    "The workspace Reserve could not be configured on the Payroll Program. Retry after checking the Reserve state.",
  reserve_confidential_account_setup_failed:
    "The workspace Reserve confidential account could not be prepared.",
  reserve_confidential_account_not_ready:
    "The workspace Reserve confidential account is not approved and ready for transfers.",
  reserve_confidential_deposit_failed:
    "Moving the organization's wrapped USDC into its confidential Reserve failed. Check the Reserve before retrying.",
  payroll_allocation_not_recoverable:
    "This allocation is no longer eligible for recovery.",
  payroll_recovery_state_conflict:
    "The allocation changed state during recovery. Refresh before retrying.",

  // Escrow funding and contributor claim (settlement).
  payroll_allocation_not_found:
    "This payroll allocation was not found for the connected wallet. Refresh the page.",
  payroll_allocation_amount_invalid:
    "This allocation's amount or claim identifier is invalid, so nothing was submitted.",
  contributor_confidential_account_not_ready:
    "Your confidential account is not set up and approved for this wallet yet. Finish confidential account setup, then retry.",
  workspace_reserve_confidential_account_not_ready:
    "The workspace Reserve confidential account is not approved and ready for transfers.",
  payroll_claim_escrow_account_not_ready:
    "The confidential allocation account is not approved to receive confidential credits yet.",
  recovery_escrow_confidential_account_not_ready:
    "The confidential allocation account is not approved for confidential transfers, so it cannot be recovered yet.",
  escrow_funding_transaction_not_verified:
    "The finalized funding transaction could not be verified against this allocation. Refresh the payroll run before funding again.",
  escrow_funding_claim_state_not_verified:
    "The funding transaction finalized, but the Claim account on Solana does not show as funded. Refresh the payroll run before funding again.",
  settlement_claim_commitment_invalid:
    "The Claim commitments recorded for this allocation are malformed, so nothing was submitted.",
  settlement_claim_state_not_verified:
    "The Claim account on Solana does not match this allocation, so Paylore stopped. Refresh; if it persists, contact support.",
  settlement_transaction_not_finalized:
    "The settlement transaction is not finalized or did not succeed on Solana. Refresh to see its recorded state.",
  settlement_transfer_binding_invalid:
    "The settlement transaction did not contain exactly one confidential transfer followed by one claim mark, so it was not accepted.",
  confidential_transfer_plan_invalid:
    "Paylore built a confidential transfer that failed its own safety check, so it was not submitted. Nothing moved. Retry; if it persists, contact support.",
  confidential_transfer_instruction_invalid:
    "The confidential transfer instruction failed Paylore's safety check, so it was not submitted. Nothing moved. Retry; if it persists, contact support.",
  confidential_proof_contexts_invalid:
    "Paylore could not record the proof accounts prepared for this confidential transfer. Nothing was submitted. Retry shortly.",
  confidential_transfer_proof_setup_failed:
    "Preparing the confidential transfer proofs failed on Solana. Paylore released the attempt and nothing moved. Retry shortly.",
  confidential_transfer_submission_failed:
    "Paylore could not confirm that the confidential transfer was submitted. Refresh to see its recorded state before retrying.",
  confidential_settlement_failed:
    "The confidential transfer could not be completed. Paylore released the attempt and no value moved. Retry shortly.",
  payroll_confidential_settlement_failed:
    "Paylore stopped the confidential transfer on an unexpected server error. The exact cause is in the server log. Refresh to see the recorded state before retrying.",
  payroll_settlement_failure_ledger_conflict:
    "The failure of this confidential transfer could not be recorded in the ledger. Refresh before retrying.",
  payroll_settlement_outcome_ledger_conflict:
    "The outcome of this confidential transfer could not be recorded in the ledger. Refresh to review it before retrying.",
  authenticated_wallet_required:
    "Sign in with your wallet to continue.",
  contributor_record_not_found:
    "No active contributor record was found for this wallet in this workspace.",

  // Recovery.
  invalid_recovery_request:
    "The recovery request was incomplete. Choose a reason (and add a note when the reason is Other), then retry.",
  payroll_recovery_reason_required:
    "A note is required when the recovery reason is Other.",
  payroll_recovery_reason_unavailable:
    "The recovery reason saved for this allocation could not be read. Refresh the page and submit the recovery again.",
  payroll_recovery_not_configured:
    "Recovery is not configured for this deployment (wrapped-USDC mint, Payroll Program or amount-commitment secret is missing).",
  payroll_recovery_token_account_missing:
    "The allocation account or the Reserve account was not found on Solana, so nothing was recovered.",
  recovery_escrow_available_balance_insufficient:
    "The allocation account does not hold the full available confidential balance yet (part of it may still be pending). Retry shortly.",
  recovery_proof_contexts_invalid:
    "Paylore could not record the proof accounts for this recovery. Nothing was submitted. Retry shortly.",
  confidential_recovery_transfer_invalid:
    "The recovery transfer failed Paylore's safety check, so it was not submitted. Nothing moved. Retry; if it persists, contact support.",
  confidential_recovery_submission_failed:
    "Paylore could not confirm that the recovery transfer was submitted. Refresh the recovery status before retrying.",
  payroll_recovery_balance_snapshot_missing:
    "The recovery transfer finalized, but the balances recorded before it are missing, so Paylore cannot confirm the value moved. Do not recover again; contact support.",
  payroll_recovery_reconciliation_conflict:
    "The recovery transfer finalized, but Paylore could not match it to this allocation. Do not recover again; contact support.",
  payroll_recovery_submission_failed:
    "The recovery request hit an unexpected server error, so its final result is not known. Refresh the recovery status before doing anything else.",
  payroll_recovery_status_unavailable:
    "The recovery status could not be loaded. Retry shortly.",

  // Gas Tank page (setup, funding).
  gas_tank_operation_failed:
    "The Gas Tank service hit an unexpected server error and the request did not complete. Nothing was signed by your wallet. The exact cause is in the server log; retry shortly.",
  gas_tank_unavailable:
    "The Gas Tank status could not be loaded. Retry shortly.",
  invalid_gas_tank_action:
    "Paylore did not recognise this Gas Tank request. Reload the page and retry.",
  request_too_large:
    "The request was too large for Paylore to accept. Reload the page and retry.",
  funding_transaction_invalid:
    "The signed transaction does not match the transfer you reviewed (payer, Gas Tank address, amount or instructions), so Paylore did not submit it. No funding was sent. Prepare the funding again.",
  funding_transaction_rejected:
    "The network rejected the funding transaction, so no funding was sent. Check that the wallet holds enough SOL, then prepare the funding again.",
  funding_transaction_not_eligible:
    "The transaction is not an eligible Gas Tank funding transfer from your wallet for this amount, so it was not credited. Check the transaction reference and amount."
};

/** Codes a contributor cannot resolve; a workspace administrator must act. */
const ADMINISTRATOR_ACTION_CODES = new Set([
  "gas_tank_not_initialized",
  "gas_tank_insufficient_balance",
  "gas_tank_daily_sponsorship_limit",
  "workspace_read_only",
  "workspace_reserve_not_initialized",
  "reserve_confidential_balance_insufficient",
  "reserve_account_requires_mint_authority_approval",
  "payroll_claim_creation_unverified"
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

/** Why the server could not verify a contributor's confidential account setup transaction. */
export function describeAccountVerificationFailure(
  code: string | null | undefined,
  httpStatus?: number
): string {
  switch (code) {
    case "confidential_account_not_ready":
      return "The finalized transaction did not leave an approved confidential account enabled for incoming confidential credits. Paylore has not marked the account ready.";
    case "confidential_mint_unavailable":
      return "The configured wrapped-USDC mint is unavailable, so the confidential account could not be verified. No account status was recorded.";
    case "invalid_setup_transaction":
      return "The transaction reference sent for verification is not a valid Solana signature. No account status was recorded.";
    case "confidential_account_setup_failed":
      return "Paylore could not verify the account transaction because of an unexpected server error. No account status was recorded. Keep the transaction reference and retry verification.";
    default:
      return code
        ? describeContributorSponsoredError(code, httpStatus)
        : "The account transaction has not been verified as finalized. Keep its transaction reference and retry verification.";
  }
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
  // Not every code comes from a Gas Tank operation (payroll, claim and recovery
  // share this helper), so do not claim anything about what was or was not done.
  return `Paylore could not complete this request (reference: ${code}${httpStatus ? `, HTTP ${httpStatus}` : ""}). Quote the reference if this repeats.`;
}
