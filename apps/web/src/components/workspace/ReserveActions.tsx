"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getTransactionDecoder
} from "@solana/kit";
import { isWalletCancellation } from "../auth/walletErrors";
import { findAuthenticatedWallet } from "./authenticated-wallet";
import { wrapOrdinaryUsdcIntoReserve } from "./confidential-account-transaction";
import { buildWorkspaceInitializationTransaction } from "./payroll-program-transaction";
import { waitForSolanaFinality } from "./payroll-transaction-finality";
import { createPayloreSolanaRpc, getPayloreWalletChain } from "./solana-network";
import { baseUnitsToUsdc, formatBaseUnits, usdcToBaseUnits } from "./reserve-funding-amount";

type ReservePhase = "account_setup" | "program_configure";
type ReserveAction = "initialize" | "restore" | "initialize_confidential";
type GasTankReservePreflight = {
  status: "not_initialized" | "funding_required" | "ready" | "unavailable";
  address: string | null;
  balanceSol: string | null;
};

type ReserveFundingPhase = "wrap_pending" | "wrap_verified" | "preapply" | "deposit" | "apply";

export function getReserveFundingOutcomeMessage(input: {
  status: "pending" | "confidential_balance_verified" | "error";
  phase?: ReserveFundingPhase;
  errorCode?: string;
}): { state: "success" | "error" | "partial"; text: string } {
  if (input.status === "confidential_balance_verified") {
    return {
      state: "success",
      text: "Ordinary USDC was wrapped, deposited into the Reserve's confidential pending balance, and applied to its available confidential balance. Paylore verified the finalized on-chain balances."
    };
  }
  if (input.status === "pending") {
    const text = input.phase === "wrap_pending"
      ? "Your ordinary-USDC wrap was submitted. Paylore saved its signature and is checking the finalized transaction. Continue this same operation; do not submit another wrap."
      : input.phase === "wrap_verified"
        ? "The ordinary-USDC wrap is finalized and verified. Paylore has not yet confirmed a confidential deposit; continue this same operation to deposit and apply the Reserve balance."
        : input.phase === "preapply"
          ? "Paylore is reconciling the Reserve's earlier pending confidential balance before depositing this funding. Continue this same operation; do not wrap USDC again."
          : input.phase === "apply"
            ? "The wrapped USDC is in the Reserve's pending confidential balance. Paylore is waiting for the apply transaction to make it available. Continue this same operation; do not wrap again."
            : "The Reserve confidential deposit is awaiting finality. Continue this same operation; do not wrap USDC again.";
    return { state: "partial", text };
  }
  const errors: Record<string, string> = {
    reserve_gas_tank_insufficient_funds:
      "The workspace Gas Tank does not have enough SOL to pay for the confidential Reserve transaction. Fund the Gas Tank, then continue this same operation; do not wrap USDC again.",
    reserve_gas_tank_daily_sponsorship_limit:
      "The workspace Gas Tank has reached its 24-hour sponsorship limit. Continue this same Reserve funding operation after earlier sponsored activity leaves the limit window; do not wrap USDC again.",
    reserve_gas_tank_sponsorship_unavailable:
      "Paylore could not safely reserve the Gas Tank fee budget. No confidential Reserve transaction was submitted. Check Gas Tank activity, then continue this same operation; do not wrap USDC again.",
    reserve_gas_tank_balance_unavailable:
      "Paylore could not verify the Gas Tank's current SOL balance. No confidential Reserve transaction was submitted. Check the Gas Tank and continue this same operation; do not wrap USDC again.",
    reserve_gas_tank_key_mismatch:
      "The Gas Tank signing address does not match its recorded key. Paylore stopped before asking your wallet to wrap USDC.",
    reserve_gas_tank_custody_unavailable:
      "Paylore could not unlock the Gas Tank signer. No USDC wrap was submitted. Check Gas Tank custody before trying again.",
    reserve_gas_tank_not_initialized:
      "Initialize and fund the workspace Gas Tank before continuing confidential Reserve funding. Your verified wrapped-USDC deposit remains available to resume; do not wrap again.",
    reserve_confidential_funding_in_progress:
      "Another Reserve funding operation is being reconciled. Continue the existing operation after it finishes; do not submit another wrap.",
    reserve_confidential_funding_retry_limit:
      "This Reserve funding operation has reached its retry limit. Paylore has stopped further transactions; contact support with the current operation details before continuing.",
    reserve_confidential_funding_public_balance_insufficient:
      "The Reserve's public wrapped-USDC balance is below the amount to deposit. Refresh its finalized balance before continuing.",
    reserve_confidential_account_not_ready:
      "The Reserve confidential account is not ready for a deposit. Complete Reserve setup and refresh its on-chain status.",
    reserve_confidential_pending_balance_not_cleared:
      "The Reserve has an earlier confidential pending balance that has not been applied. Paylore stopped before making another deposit.",
    reserve_confidential_funding_operation_conflict:
      "Another funding attempt changed the Reserve operation state. Refresh its status and continue the existing operation; do not wrap USDC again.",
    reserve_confidential_deposit_amount_invalid:
      "The amount is outside the confidential Token-2022 deposit limit. Enter a smaller USDC amount and retry.",
    reserve_wrap_source_usdc_missing:
      "Your wallet has no ordinary Circle configured network USDC token account. Fund it with Circle configured network USDC before trying again.",
    reserve_wrap_source_usdc_insufficient:
      "Your wallet does not have enough ordinary Circle configured network USDC for this amount.",
    reserve_wrap_identity_mismatch:
      "The configured Token Wrap program or USDC mint does not match the approved configured network identity. No transaction was submitted.",
    reserve_wrap_program_unavailable:
      "Paylore could not verify the approved Token Wrap program as deployed and executable. No wallet transaction was submitted.",
    reserve_wrap_preflight_unavailable:
      "Paylore could not verify the wallet USDC and Reserve accounts. No wallet transaction was submitted.",
    reserve_wrap_destination_account_mismatch:
      "The Reserve wrapped-USDC token account owner or mint did not match the configured Reserve. No wallet transaction was submitted.",
    reserve_wrap_source_account_mismatch:
      "Your ordinary-USDC token account owner or mint did not match the connected wallet. No wallet transaction was submitted.",
    reserve_confidential_preapply_instruction_changed:
      "The Reserve's earlier pending confidential balance changed after Paylore prepared to apply it, so no apply transaction was submitted. Refresh the on-chain check and continue this same operation; if this message returns, contact support. Do not wrap USDC again.",
    reserve_confidential_preapply_balance_mismatch:
      "The Reserve's finalized balances did not match the expected result of applying its earlier pending balance. Paylore stopped before depositing this funding. Refresh the on-chain check and contact support if this message returns; do not wrap USDC again.",
    reserve_confidential_funding_balance_changed:
      "The Reserve's balances changed before the confidential deposit, so no deposit was submitted. Your wrapped USDC remains in the Reserve. Refresh the on-chain check and continue this same operation; do not wrap USDC again.",
    reserve_confidential_deposit_instruction_changed:
      "The confidential deposit Paylore prepared no longer matches this funding operation, so no deposit was submitted. Your wrapped USDC remains in the Reserve's public balance. Contact support with this operation's details; do not wrap USDC again.",
    reserve_confidential_deposit_balance_mismatch:
      "The Reserve's finalized balances did not match the expected confidential deposit. Paylore stopped before applying it and has not marked the funding complete. Refresh the on-chain check and contact support if this message returns; do not wrap USDC again.",
    reserve_confidential_pending_balance_mismatch:
      "The Reserve's pending confidential balance does not match this funding amount, so Paylore stopped before applying it. Refresh the on-chain check and contact support if this message returns; do not wrap USDC again.",
    reserve_confidential_apply_instruction_changed:
      "The Reserve's confidential balance changed after Paylore prepared the apply transaction, so no apply transaction was submitted. The deposit remains in the pending confidential balance. Refresh the on-chain check and continue this same operation; if this message returns, contact support. Do not wrap USDC again.",
    reserve_confidential_apply_balance_mismatch:
      "The Reserve's finalized balances did not match the expected apply result, so Paylore has not marked the funding complete. Refresh the on-chain check and contact support if this message returns; do not wrap USDC again.",
    reserve_confidential_funding_transaction_failed:
      "A confidential Reserve transaction failed on-chain. Paylore recorded the failure and has not marked the funding complete. Continue this same operation to retry it safely; do not wrap USDC again.",
    reserve_confidential_funding_signature_mismatch:
      "A Reserve transaction signature did not match the one Paylore recorded for this operation. Paylore stopped for safety; contact support before continuing. Do not wrap USDC again.",
    reserve_confidential_funding_instruction_mismatch:
      "A finalized Reserve transaction did not contain the instruction Paylore recorded for this operation. Paylore stopped for safety; contact support before continuing. Do not wrap USDC again.",
    reserve_confidential_funding_authority_mismatch:
      "A finalized Reserve transaction was not authorized by this workspace's Reserve. Paylore stopped for safety; contact support before continuing. Do not wrap USDC again.",
    reserve_confidential_funding_account_mismatch:
      "A finalized Reserve transaction touched an unexpected token account. Paylore stopped for safety; contact support before continuing. Do not wrap USDC again.",
    reserve_confidential_funding_public_debit_mismatch:
      "The Reserve's public wrapped-USDC debit did not match the confidential deposit amount. Paylore stopped for safety; contact support before continuing. Do not wrap USDC again.",
    reserve_confidential_funding_failed_transaction_not_verified:
      "A Reserve transaction failed, but Paylore could not verify that it changed nothing. Paylore stopped for safety; refresh the on-chain check and contact support before continuing. Do not wrap USDC again.",
    reserve_confidential_funding_instruction_data_missing:
      "Paylore could not prepare the confidential Reserve instruction. No transaction was submitted. Continue this same operation; do not wrap USDC again.",
    reserve_confidential_funding_balance_unavailable:
      "Paylore could not read the Reserve's finalized token balances. Nothing new was marked complete. Wait a moment and continue this same operation; do not wrap USDC again.",
    reserve_confidential_funding_status_unavailable:
      "Paylore could not read the status of the submitted Reserve transaction from configured network. Wait a moment and continue this same operation; do not wrap USDC again.",
    reserve_confidential_funding_signature_unavailable:
      "Paylore could not sign the confidential Reserve transaction. No transaction was submitted. Continue this same operation; do not wrap USDC again.",
    reserve_confidential_funding_blockhash_unavailable:
      "configured network did not return a recent blockhash, so no confidential Reserve transaction was submitted. Wait a moment and continue this same operation; do not wrap USDC again.",
    reserve_confidential_funding_fee_unavailable:
      "Paylore could not read the network fee of a finalized Reserve transaction. Wait a moment and continue this same operation; do not wrap USDC again.",
    reserve_confidential_funding_unavailable:
      "Paylore could not complete this confidential Reserve funding step. Nothing new was marked complete. Continue this same operation; do not wrap USDC again.",
    reserve_confidential_funding_operation_unavailable:
      "Paylore could not load the saved Reserve funding operation. Refresh the page and continue this same operation; do not wrap USDC again.",
    reserve_wrap_funding_unavailable:
      "Paylore could not finish checking this Reserve funding step. Nothing new was marked complete. Continue this same operation; do not wrap USDC again.",
    reserve_wrap_failure_reconciliation_unavailable:
      "The ordinary-USDC wrap failed on-chain, but Paylore could not record that result yet. Refresh the Reserve before starting a new wrap.",
    reserve_wrap_transaction_status_unavailable:
      "Paylore could not read the ordinary-USDC wrap status from configured network yet. Your signature is saved. Wait a moment and continue this same operation; do not wrap USDC again.",
    reserve_wrap_signature_invalid:
      "The saved wrap signature is not a valid Solana signature. Paylore stopped before any confidential Reserve transaction; contact support with this operation's details.",
    reserve_wrap_signature_mismatch:
      "The finalized wrap transaction does not carry the signature Paylore recorded. Paylore stopped for safety; contact support before continuing. Do not wrap USDC again.",
    reserve_wrap_wallet_signature_missing:
      "The finalized wrap transaction was not signed by your connected admin wallet. Paylore stopped for safety; contact support before continuing. Do not wrap USDC again.",
    reserve_wrap_instruction_not_verified:
      "The finalized wrap transaction did not contain the expected Token Wrap instruction. Paylore stopped before any confidential Reserve transaction; contact support. Do not wrap USDC again.",
    reserve_wrap_token_account_identity_mismatch:
      "A token account in the finalized wrap did not match the expected wallet, escrow, or Reserve account. Paylore stopped for safety; contact support. Do not wrap USDC again.",
    reserve_wrap_token_balance_not_verified:
      "Paylore could not find exactly one matching token balance in the finalized wrap. Paylore stopped before any confidential Reserve transaction; contact support. Do not wrap USDC again.",
    reserve_wrap_balance_delta_invalid:
      "The finalized wrap's USDC debit, escrow credit, and Reserve credit did not match this funding amount. Paylore stopped for safety; contact support. Do not wrap USDC again.",
    reserve_wrap_escrow_account_mismatch:
      "The Token Wrap escrow account did not match the approved configured network identity. No wallet transaction was submitted.",
    reserve_wrap_mint_program_mismatch:
      "A configured mint is not owned by the expected token program. No wallet transaction was submitted.",
    reserve_wrap_operation_conflict:
      "This wrap signature belongs to a different Reserve funding operation or amount. Refresh the page and continue the saved operation; do not wrap USDC again.",
    reserve_wrap_amount_invalid:
      "The amount is outside the supported USDC range. Enter a positive amount with up to six decimal places.",
    reserve_token_account_program_mismatch:
      "The Reserve token account is not owned by the Token-2022 program. Paylore stopped before any confidential Reserve transaction; contact support.",
    reserve_program_configuration_not_verified:
      "Paylore could not verify the Paylore Program reserve configuration on configured network. Nothing new was marked complete. Refresh the on-chain check and continue this same operation; do not wrap USDC again.",
    invalid_reserve_wrap_request:
      "The Reserve funding request was incomplete. Refresh the page and continue the saved operation; do not wrap USDC again.",
    request_not_allowed:
      "This browser request was blocked by Paylore's request checks. Reload the Reserve page from Paylore and continue this same operation; do not wrap USDC again.",
    reserve_not_found:
      "This workspace has no Reserve key custody. Configure Reserve key custody before funding it.",
    reserve_program_not_configured:
      "The Paylore Program reserve state is not configured. Complete Reserve setup and refresh its on-chain status before funding.",
    reserve_program_state_invalid:
      "The Paylore Program reserve state could not be verified. Paylore stopped before any confidential Reserve transaction; refresh the on-chain check.",
    reserve_program_state_malformed:
      "The Paylore Program reserve state could not be verified. Paylore stopped before any confidential Reserve transaction; refresh the on-chain check.",
    reserve_program_state_mismatch:
      "The Paylore Program reserve state does not match this workspace's Reserve. Paylore stopped before any confidential Reserve transaction; contact support.",
    workspace_read_only:
      "This workspace is read-only. Activate or renew it, then continue this same Reserve funding operation; do not wrap USDC again.",
    authentication_required:
      "Your session has ended. Sign in again, then continue this same Reserve funding operation; do not wrap USDC again.",
    workspace_access_denied:
      "Only a workspace organization admin can fund the Reserve."
  };
  return {
    state: "error",
    text: errors[input.errorCode ?? ""] ??
      "Paylore could not verify the confidential Reserve funding step. Check the same transaction and Reserve balance before retrying; do not submit a duplicate wrap."
  };
}


export function canFundReserveWithOrdinaryUsdc(
  status: OnChainAccountState["status"],
  confidentialTransferReady: boolean
): boolean {
  return status === "program_configured" && confidentialTransferReady;
}

export function canStartOrdinaryUsdcReserveFunding(
  status: OnChainAccountState["status"],
  confidentialTransferReady: boolean,
  gasTankStatus: GasTankReservePreflight["status"]
): boolean {
  return canFundReserveWithOrdinaryUsdc(status, confidentialTransferReady) &&
    (gasTankStatus === "ready" || gasTankStatus === "funding_required");
}

export function gasTankAllowsReserveInitialization(
  status: GasTankReservePreflight["status"]
): boolean {
  return status === "ready" || status === "funding_required";
}

export function getReserveActionErrorMessage(
  errorCode: string | undefined,
  action: ReserveAction
): string {
  const messageByError: Record<string, string> = {
    reserve_mint_authority_approval_required:
      "The wrapped-USDC mint has not approved the reserve for confidential transfers. The reserve account was not marked ready.",
    workspace_program_not_initialized:
      "The Paylore Program workspace state is not initialized. Retry Reserve setup to initialize it once with your connected admin wallet.",
    reserve_confidential_account_not_ready:
      "The reserve token account does not yet have verified confidential-transfer readiness. No reserve readiness is claimed.",
    reserve_gas_tank_not_initialized:
      "Set up the workspace Gas Tank before initializing the confidential reserve.",
    reserve_gas_tank_insufficient_funds:
      "The workspace Gas Tank does not have enough SOL to cover Reserve setup fees and reserve account rent. Fund the Gas Tank, then retry.",
    reserve_gas_tank_balance_unavailable:
      "Paylore could not verify the current live SOL balance for the Gas Tank. Reserve setup may be partially complete; refresh the Gas Tank and Reserve status before retrying.",
    reserve_gas_tank_key_mismatch:
      "The stored Gas Tank signing identity did not match its recorded address. Reserve setup was stopped for safety; contact support before retrying.",
    reserve_gas_tank_custody_unavailable:
      "Paylore could not access the encrypted Gas Tank signing key. Reserve setup was not confirmed. Retry after checking Gas Tank status.",
    reserve_token_account_identity_mismatch:
      "The expected reserve token account exists with a different owner or mint. No reserve setup transaction was submitted."
  };
  const specificMessage = errorCode ? messageByError[errorCode] : undefined;
  if (specificMessage) return specificMessage;
  if (action === "initialize") {
    return "Reserve signing-key custody could not be configured. Please try again.";
  }
  if (action === "restore") {
    return "The encrypted reserve signing-key backup could not be verified. Please try again.";
  }
  return "Paylore could not complete confidential reserve setup. Refresh the Reserve page and check any submitted transaction before trying again.";
}
type OnChainAccountState = {
  status:
    | "not_checked"
    | "no_reserve"
    | "not_configured"
    | "account_missing"
    | "confidential_account_ready"
    | "workspace_program_not_initialized"
    | "program_configured";
  reserveAddress?: string;
  tokenAccount?: string | null;
  confidentialTransferReady?: boolean;
  publicBalanceBaseUnits?: string;
  availableBalanceBaseUnits?: string;
  pendingBalanceBaseUnits?: string;
  fundingState?: "unfunded" | "public_funds_available" | "pending_confidential_balance" | "confidential_funds_available";
  programReserveConfigured?: boolean;
  signature?: string;
  phase?: ReservePhase;
  workspaceInitialization?: {
    authorityAddress: string;
    workspaceAddress: string;
    programId: string;
    gasTankAddress?: string | null;
  };
};

function fundingStateLabel(state: OnChainAccountState["fundingState"]): string {
  switch (state) {
    case "confidential_funds_available": return "Confidential funds available";
    case "pending_confidential_balance": return "Confidential funds pending";
    case "public_funds_available": return "Public wrapped-USDC available";
    case "unfunded": return "No funds detected";
    default: return "Unavailable";
  }
}

function fundingStateDescription(state: OnChainAccountState["fundingState"]): string {
  switch (state) {
    case "confidential_funds_available":
      return "A finalized confidential available balance is present. Each payroll claim still checks the exact amount required before transfer.";
    case "pending_confidential_balance":
      return "Funds are in the confidential pending balance and cannot be transferred until applied. Paylore applies pending reserve funds during settlement.";
    case "public_funds_available":
      return "Public wrapped-USDC is present. Settlement deposits the required amount into the confidential balance before transferring, after checking the exact allocation.";
    case "unfunded":
      return "No public, pending, or available wrapped-USDC funds were found in finalized state. Fund this reserve before expecting a payroll claim to settle.";
    default:
      return "Funding state is unavailable. Refresh the finalized on-chain check before relying on reserve readiness.";
  }
}

/** Shows exact base units as readable USDC with the grouped base-unit value beside it. */
export function ReserveAmount({ baseUnits }: { baseUnits?: string | null }) {
  const usdc = typeof baseUnits === "string" ? baseUnitsToUsdc(baseUnits) : null;
  if (usdc === null || typeof baseUnits !== "string") {
    return <span className="reserve-amount reserve-amount--unavailable">Unavailable</span>;
  }
  return (
    <span className="reserve-amount">
      <span className="reserve-amount__value financial-value">{usdc} USDC</span>
      <span className="reserve-amount__base numeric">{formatBaseUnits(baseUnits)} base units</span>
    </span>
  );
}

const FUNDING_STEPS = [
  "Wrap ordinary USDC",
  "Deposit into the confidential pending balance",
  "Apply to the available confidential balance"
] as const;

/** Index of the funding step still in progress; earlier steps are finalized and verified. */
export function reserveFundingStepIndex(phase: ReserveFundingPhase | undefined): number {
  switch (phase) {
    case "wrap_verified":
    case "preapply":
    case "deposit":
      return 1;
    case "apply":
      return 2;
    default:
      return 0;
  }
}

/**
 * Wallets reject an unrecognized `commitment` send option, so the admin wallet
 * only signs and Paylore submits the exact signed bytes to configured network.
 */
async function submitWorkspaceInitialization(
  wallet: ReturnType<typeof findAuthenticatedWallet>,
  transaction: Uint8Array
): Promise<string> {
  if (!wallet.signTransaction) {
    const [sent] = await wallet.signAndSendTransaction({
      account: wallet.account,
      chain: getPayloreWalletChain(),
      transaction
    });
    if (!sent) {
      throw new Error("The wallet did not return a workspace initialization signature.");
    }
    return getBase58Decoder().decode(sent.signature);
  }
  const [signed] = await wallet.signTransaction({
    account: wallet.account,
    chain: getPayloreWalletChain(),
    transaction
  });
  if (!signed) {
    throw new Error("The wallet did not sign the workspace initialization transaction.");
  }
  const decoded = getTransactionDecoder().decode(signed.signedTransaction);
  return await createPayloreSolanaRpc()
    .sendTransaction(getBase64EncodedWireTransaction(decoded), {
      encoding: "base64",
      preflightCommitment: "confirmed"
    })
    .send();
}

export function ReserveActions({
  workspaceId,
  reserve,
  canInitialize,
  gasTankPreflight
}: {
  workspaceId: string;
  gasTankPreflight: GasTankReservePreflight;
  reserve: {
    address: string;
    createdAt: string;
    updatedAt: string;
  } | null;
  canInitialize: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [activeAction, setActiveAction] = useState<ReserveAction | null>(null);
  const [notice, setNotice] = useState<{
    state: "success" | "error" | "partial";
    text: string;
  } | null>(null);
  const [onChainAccount, setOnChainAccount] = useState<OnChainAccountState>({
    status: "not_checked",
    tokenAccount: null
  });
  const [checkingOnChain, setCheckingOnChain] = useState(true);
  const [setupSignature, setSetupSignature] = useState<string | null>(null);
  const [setupPhase, setSetupPhase] = useState<ReservePhase | null>(null);
  const [fundingAmount, setFundingAmount] = useState("");
  const [fundingBusy, setFundingBusy] = useState(false);
  const [fundingNotice, setFundingNotice] = useState<{
    state: "success" | "error" | "partial";
    text: string;
  } | null>(null);
  const [pendingWrap, setPendingWrap] = useState<{
    signature: string;
    amountBaseUnits: string;
    phase?: ReserveFundingPhase;
    stage?: string;
  } | null>(null);

  const loadOnChainState = useCallback(async () => {
    const response = await fetch(
      `/api/workspaces/${workspaceId}/settings/reserve`,
      { cache: "no-store", credentials: "same-origin" }
    );
    const result = await response.json() as { onChainAccount?: OnChainAccountState; error?: string };
    if (!response.ok || !result?.onChainAccount) {
      throw new Error(result?.error ?? "Reserve on-chain state could not be reconciled.");
    }
    return result.onChainAccount;
  }, [workspaceId]);

  const refreshOnChainState = useCallback(async () => {
    setCheckingOnChain(true);
    try {
      const state = await loadOnChainState();
      setOnChainAccount(state);
      if (state.status === "program_configured") {
        setSetupSignature(null);
        setSetupPhase(null);
      }
    } catch (error) {
      setOnChainAccount({ status: "not_checked", tokenAccount: null });
      setNotice({
        state: "error",
        text: error instanceof Error
          ? error.message
          : "Reserve on-chain state could not be reconciled."
      });
    } finally {
      setCheckingOnChain(false);
    }
  }, [loadOnChainState]);

  useEffect(() => {
    let active = true;
    loadOnChainState().then((state) => {
      if (!active) return;
      setOnChainAccount(state);
      if (state.status === "program_configured") {
        setSetupSignature(null);
        setSetupPhase(null);
      }
    }).catch((error: unknown) => {
      if (!active) return;
      setOnChainAccount({ status: "not_checked", tokenAccount: null });
      setNotice({
        state: "error",
        text: error instanceof Error
          ? error.message
          : "Reserve on-chain state could not be reconciled."
      });
    }).finally(() => {
      if (active) setCheckingOnChain(false);
    });
    return () => {
      active = false;
    };
  }, [loadOnChainState]);

  useEffect(() => {
    let active = true;
    fetch("/api/workspaces/" + workspaceId + "/settings/reserve/funding", {
      method: "GET",
      credentials: "same-origin",
      cache: "no-store"
    }).then(async (response) => {
      const result = await response.json().catch(() => null) as {
        status?: string;
        wrapSignature?: string;
        amountBaseUnits?: string;
        phase?: ReserveFundingPhase;
        stage?: string;
        message?: string;
      } | null;
      if (!active || !result) return;
      if (
        response.ok &&
        result.status === "pending" &&
        typeof result.wrapSignature === "string" &&
        typeof result.amountBaseUnits === "string" &&
        /^[1-9][0-9]*$/.test(result.amountBaseUnits)
      ) {
        setPendingWrap({
          signature: result.wrapSignature,
          amountBaseUnits: result.amountBaseUnits,
          phase: result.phase,
          stage: result.stage
        });
        setFundingNotice(getReserveFundingOutcomeMessage({
          status: "pending",
          phase: result.phase
        }));
      } else if (result.status === "another_admin_pending") {
        setFundingNotice({
          state: "partial",
          text: result.message ?? "A Reserve funding operation is already in progress. Continue that same operation before starting another."
        });
      }
    }).catch(() => {
      // A failed status read must not create a local success or erase a submitted signature.
    });
    return () => {
      active = false;
    };
  }, [workspaceId]);

  async function run(action: ReserveAction, retryingWorkspace = false) {
    if ((!retryingWorkspace && busy) || fundingBusy) return;
    setBusy(true);
    setActiveAction(action);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/settings/reserve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            action,
            ...(action === "initialize_confidential"
              ? { signature: setupSignature, phase: setupPhase }
              : {})
          })
        }
      );
      const result = await response.json().catch(() => null) as {
        status?: string;
        error?: string;
        signature?: string | null;
        phase?: ReservePhase | null;
        tokenAccount?: string | null;
        confidentialTransferReady?: boolean;
        publicBalanceBaseUnits?: string;
        availableBalanceBaseUnits?: string;
        pendingBalanceBaseUnits?: string;
        fundingState?: "unfunded" | "public_funds_available" | "pending_confidential_balance" | "confidential_funds_available";
        programReserveConfigured?: boolean;
        workspaceInitialization?: {
          authorityAddress: string;
          workspaceAddress: string;
          programId: string;
          gasTankAddress?: string | null;
        };
        created?: boolean;
        restoredAt?: string | null;
      } | null;

      if (!response.ok) {
        setNotice({
          state: "error",
          text: getReserveActionErrorMessage(result?.error, action)
        });
        return;
      }

      if (action === "initialize_confidential") {
        if (result?.status === "pending") {
          setSetupSignature(result.signature ?? setupSignature);
          setSetupPhase(result.phase ?? setupPhase);
          setNotice({
            state: "partial",
            text: result.phase === "account_setup"
              ? "The reserve confidential-account setup transaction is awaiting finality. Check this same attempt before starting another."
              : "The Payroll Program reserve configuration is awaiting finality. Check this same attempt before starting another."
          });
          await refreshOnChainState();
          return;
        }
        if (result?.status === "retry_ready") {
          setSetupSignature(null);
          setSetupPhase(null);
          setNotice({
            state: "partial",
            text: "The previous reserve setup transaction finalized unsuccessfully. Recheck the account state before starting a new attempt."
          });
          await refreshOnChainState();
          return;
        }
        if (result?.status === "workspace_program_not_initialized") {
          setSetupSignature(null);
          setSetupPhase(null);
          if (!retryingWorkspace && result.workspaceInitialization) {
            try {
              const wallet = findAuthenticatedWallet(
                result.workspaceInitialization.authorityAddress
              );
              const transaction = await buildWorkspaceInitializationTransaction({
                authorityAddress: result.workspaceInitialization.authorityAddress,
                payerAddress: result.workspaceInitialization.gasTankAddress ?? undefined,
                workspaceId,
                programId: result.workspaceInitialization.programId
              });
              const initializationSignature = await submitWorkspaceInitialization(
                wallet,
                transaction
              );
              setNotice({
                state: "partial",
                text: "The Payroll Program workspace initialization was submitted. Paylore is waiting for network finality before continuing confidential Reserve setup."
              });
              // The server verifies the workspace account at finalized commitment.
              await waitForSolanaFinality(initializationSignature);
              await run(action, true);
              return;
            } catch (error) {
              setNotice({
                state: isWalletCancellation(error) ? "partial" : "error",
                text: isWalletCancellation(error)
                  ? "Workspace initialization was cancelled. No Reserve setup transaction was submitted."
                  : error instanceof Error
                    ? error.message
                    : "The Payroll Program workspace could not be initialized. No Reserve setup transaction was submitted."
              });
              return;
            }
          }
          setNotice({
            state: "partial",
            text: result.confidentialTransferReady
              ? "The reserve-owned confidential account is ready, but the Paylore Program workspace state is not initialized. Retry to initialize it once and continue reserve setup."
              : "The Paylore Program workspace state is not initialized. Retry to initialize it once with your connected admin wallet, then continue reserve setup."
          });
          setOnChainAccount(result as OnChainAccountState);
          return;
        }
        if (result?.status === "program_configured" && result.programReserveConfigured === true &&
            result.confidentialTransferReady === true && typeof result.tokenAccount === "string") {
          setSetupSignature(null);
          setSetupPhase(null);
          setOnChainAccount(result as OnChainAccountState);
          setNotice({
            state: "success",
            text: "The reserve confidential account and Paylore Program reserve state were verified. This does not mean the reserve has been funded."
          });
          router.refresh();
          return;
        }
        setSetupSignature(null);
        setSetupPhase(null);
        await refreshOnChainState();
        setNotice({
          state: "partial",
          text: "The reserve setup did not establish a verified configured reserve. Review the on-chain state before retrying."
        });
        return;
      }

      setNotice({
        state: "success",
        text: action === "initialize"
          ? "Reserve signing-key custody configured. This does not create or fund an on-chain confidential reserve."
          : "The encrypted reserve signing-key backup was verified and restored. On-chain reserve readiness is checked separately."
      });
      router.refresh();
      await refreshOnChainState();
    } catch {
      setNotice({
        state: "partial",
        text: action === "initialize_confidential"
          ? "The reserve response was interrupted. Check the existing on-chain setup state before starting another attempt."
          : "Reserve unavailable — try again. No private-key material is shown here."
      });
    } finally {
      setBusy(false);
      setActiveAction(null);
    }
  }


  async function fundReserveWithOrdinaryUsdc() {
    if (busy || fundingBusy) return;
    let amountBaseUnits: string;
    try {
      amountBaseUnits = pendingWrap ? pendingWrap.amountBaseUnits : usdcToBaseUnits(fundingAmount);
    } catch (error) {
      setFundingNotice({
        state: "error",
        text: error instanceof Error ? error.message : "Enter a valid USDC amount."
      });
      return;
    }
    setFundingBusy(true);
    setFundingNotice(null);
    let walletSubmissionStarted = false;
    let activeSignature = pendingWrap?.signature ?? null;
    try {
      if (!activeSignature) {
        const preparedResponse = await fetch(
          "/api/workspaces/" + workspaceId + "/settings/reserve/funding",
          {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "prepare", amountBaseUnits })
          }
        );
        const prepared = await preparedResponse.json().catch(() => null) as {
          walletAddress?: string;
          reserveAddress?: string;
          reserveTokenAccountAddress?: string;
          wrappedMintAddress?: string;
          unwrappedMintAddress?: string;
          tokenWrapProgramAddress?: string;
          error?: string;
        } | null;
        if (
          !preparedResponse.ok ||
          !prepared?.walletAddress ||
          !prepared.reserveAddress ||
          !prepared.reserveTokenAccountAddress ||
          !prepared.wrappedMintAddress ||
          !prepared.unwrappedMintAddress ||
          !prepared.tokenWrapProgramAddress
        ) {
          throw new Error(prepared?.error ?? "Reserve funding preflight failed. No wallet transaction was submitted.");
        }
        const wallet = findAuthenticatedWallet(prepared.walletAddress);
        walletSubmissionStarted = true;
        const result = await wrapOrdinaryUsdcIntoReserve(wallet, {
          walletAddress: prepared.walletAddress,
          reserveAddress: prepared.reserveAddress,
          reserveTokenAccountAddress: prepared.reserveTokenAccountAddress,
          wrappedMintAddress: prepared.wrappedMintAddress,
          unwrappedMintAddress: prepared.unwrappedMintAddress,
          tokenWrapProgramAddress: prepared.tokenWrapProgramAddress,
          amountBaseUnits: BigInt(amountBaseUnits)
        });
        activeSignature = result.signature;
        setPendingWrap({ signature: activeSignature, amountBaseUnits });
        walletSubmissionStarted = false;
      }

      const verificationResponse = await fetch(
        "/api/workspaces/" + workspaceId + "/settings/reserve/funding",
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            action: "verify",
            amountBaseUnits,
            signature: activeSignature
          })
        }
      );
      const verification = await verificationResponse.json().catch(() => null) as {
        status?: "pending" | "confidential_balance_verified";
        error?: string;
        phase?: ReserveFundingPhase;
        stage?: string;
      } | null;
      if (verificationResponse.status === 202 || verification?.status === "pending") {
        setPendingWrap({
          signature: activeSignature,
          amountBaseUnits,
          phase: verification?.phase,
          stage: verification?.stage
        });
        setFundingNotice(getReserveFundingOutcomeMessage({
          status: "pending",
          phase: verification?.phase
        }));
        await refreshOnChainState();
        return;
      }
      if (!verificationResponse.ok || verification?.status !== "confidential_balance_verified") {
        if (verification?.error === "reserve_wrap_transaction_failed") {
          setPendingWrap(null);
          setFundingNotice({
            state: "error",
            text: "The ordinary-USDC wrap failed on-chain. No Reserve confidential deposit was made. Refresh the Reserve before starting a new wrap."
          });
        } else {
          if (activeSignature) {
            const signature = activeSignature;
            setPendingWrap((current) => ({
              signature,
              amountBaseUnits,
              phase: current?.signature === signature ? current.phase : undefined,
              stage: current?.signature === signature ? current.stage : undefined
            }));
          }
          setFundingNotice(getReserveFundingOutcomeMessage({
            status: "error",
            errorCode: verification?.error
          }));
        }
        return;
      }
      setPendingWrap(null);
      setFundingNotice(getReserveFundingOutcomeMessage({
        status: "confidential_balance_verified"
      }));
      await refreshOnChainState();
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const signatureFromError = message.match(/[1-9A-HJ-NP-Za-km-z]{80,90}/)?.[0];
      if (signatureFromError) {
        setPendingWrap({ signature: signatureFromError, amountBaseUnits });
        setFundingNotice(getReserveFundingOutcomeMessage({ status: "pending" }));
      } else if (activeSignature && !isWalletCancellation(error)) {
        setPendingWrap(pendingWrap ?? { signature: activeSignature, amountBaseUnits });
        setFundingNotice(getReserveFundingOutcomeMessage({
          status: "error",
          errorCode: message
        }));
      } else if (isWalletCancellation(error)) {
        setFundingNotice({
          state: "partial",
          text: "The wallet request was cancelled. No new Reserve wrap was confirmed."
        });
      } else if (walletSubmissionStarted) {
        setFundingNotice({
          state: "partial",
          text: "The wallet did not confirm whether it submitted the wrap. Check wallet activity before retrying; do not submit a duplicate."
        });
      } else {
        const codedFailure = /^[a-z][a-z0-9_]+$/.test(message);
        setFundingNotice(codedFailure
          ? getReserveFundingOutcomeMessage({ status: "error", errorCode: message })
          : {
              state: "error",
              text: message || "The Reserve wrap could not be completed. No success has been recorded."
            });
      }
    } finally {
      setFundingBusy(false);
    }
  }


  const fundingAvailable = canStartOrdinaryUsdcReserveFunding(
    onChainAccount.status,
    onChainAccount.confidentialTransferReady === true,
    gasTankPreflight.status
  ) && Boolean(onChainAccount.tokenAccount);
  const fundingStep = reserveFundingStepIndex(pendingWrap?.phase);
  const setupBusy = busy && (activeAction === "restore" || activeAction === "initialize_confidential");

  return (
    <div className="reserve-actions">
      {notice ? (
        <div className="state-callout" data-state={notice.state} role={notice.state === "error" ? "alert" : "status"}>
          <span className="state-callout__signal" aria-hidden="true" />
          <p>{notice.text}</p>
        </div>
      ) : null}
      <section
        className="state-callout reserve-gas-tank"
        data-state={
          gasTankPreflight.status === "ready"
            ? "success"
            : gasTankPreflight.status === "funding_required"
              ? "partial"
              : "error"
        }
        aria-labelledby="reserve-gas-tank-status"
      >
        <span className="state-callout__signal" aria-hidden="true" />
        <div className="reserve-gas-tank__body">
          <h3 id="reserve-gas-tank-status">Gas Tank funding comes first</h3>
          {gasTankPreflight.status === "not_initialized" ? (
            <>
              <p>Initialize the workspace Gas Tank and fund it with SOL before confidential Reserve setup. The Gas Tank pays setup transaction fees and reserve account rent; the Reserve remains the token owner and authority.</p>
              <div className="reserve-panel__actions">
                <Link className="button button--secondary" href={`/workspace/${workspaceId}/gas-tank`}>Set up Gas Tank</Link>
              </div>
            </>
          ) : gasTankPreflight.status === "funding_required" ? (
            <>
              <p>The current Gas Tank balance is {gasTankPreflight.balanceSol} SOL, below the 0.05 SOL low-balance warning threshold used by Paylore. This threshold is a warning, not a fee quote: Paylore checks a conservative rent allowance plus a network-fee buffer before submitting setup transactions and stops if the balance is insufficient.</p>
              <div className="reserve-panel__actions">
                <Link className="button button--secondary" href={`/workspace/${workspaceId}/gas-tank`}>Review and fund Gas Tank</Link>
              </div>
            </>
          ) : gasTankPreflight.status === "unavailable" ? (
            <>
              <p>Paylore could not verify the current live SOL balance for the Gas Tank. Confidential Reserve initialization is disabled until the current balance can be checked.</p>
              <div className="reserve-panel__actions">
                <Link className="button button--secondary" href={`/workspace/${workspaceId}/gas-tank`}>Check Gas Tank</Link>
              </div>
            </>
          ) : (
            <>
              <p>The Gas Tank is initialized and its current balance is {gasTankPreflight.balanceSol} SOL. Paylore will check a conservative rent allowance and network-fee buffer immediately before any Reserve setup transaction.</p>
              {gasTankPreflight.address ? <p className="reserve-address">Gas Tank address: <code>{gasTankPreflight.address}</code></p> : null}
            </>
          )}
        </div>
      </section>
      {reserve ? (
        <>
          <section className="reserve-panel" aria-labelledby="reserve-custody-heading">
            <header className="reserve-panel__header">
              <h2 id="reserve-custody-heading">Reserve key custody configured</h2>
            </header>
            <dl className="reserve-facts">
              <div><dt>Signing-key custody</dt><dd>Configured</dd></div>
              <div className="reserve-facts__wide"><dt>Reserve signing address</dt><dd><code>{reserve.address}</code></dd></div>
              <div><dt>Key custody configured</dt><dd>{new Date(reserve.createdAt).toLocaleString()}</dd></div>
              <div><dt>Key custody last updated</dt><dd>{new Date(reserve.updatedAt).toLocaleString()}</dd></div>
            </dl>
          </section>

          <section className="reserve-panel" aria-labelledby="reserve-readiness-heading">
            <header className="reserve-panel__header reserve-panel__header--split">
              <h3 id="reserve-readiness-heading">Confidential reserve readiness</h3>
              <div className="reserve-panel__actions">
                <button className="button button--secondary" disabled={checkingOnChain || busy || fundingBusy} aria-busy={checkingOnChain} onClick={() => {
                  setCheckingOnChain(true);
                  void refreshOnChainState();
                }} type="button">
                  Refresh on-chain check
                </button>
              </div>
            </header>
            {checkingOnChain ? (
              <p className="loading-indicator" role="status">
                <span className="loading-indicator__icon" aria-hidden="true" />
                Checking finalized configured network account and program state…
              </p>
            ) : onChainAccount.status === "account_missing" ? (
              <p role="status">The expected reserve-owned wrapped-USDC Token-2022 account does not exist. Confidential settlement is unavailable.</p>
            ) : onChainAccount.status === "workspace_program_not_initialized" ? (
              <p role="status">The reserve confidential token account is ready, but the Paylore Program workspace account has not been initialized. The reserve program state is not configured.</p>
            ) : onChainAccount.status === "confidential_account_ready" ? (
              <p role="status">The reserve confidential token account is configured, but the Paylore Program reserve state is not yet verified.</p>
            ) : onChainAccount.status === "program_configured" ? (
              <>
                <p role="status">The finalized reserve token account and Paylore Program reserve state match. The state check does not by itself mean the reserve is funded.</p>
                <dl className="reserve-facts">
                  <div><dt>Confidential transfers ready</dt><dd>{onChainAccount.confidentialTransferReady ? "Yes" : "No"}</dd></div>
                  <div><dt>Funding readiness</dt><dd>{fundingStateLabel(onChainAccount.fundingState)}</dd></div>
                </dl>
                <dl className="reserve-balances">
                  <div><dt>Public wrapped-USDC balance</dt><dd><ReserveAmount baseUnits={onChainAccount.publicBalanceBaseUnits} /></dd></div>
                  <div><dt>Available confidential balance</dt><dd><ReserveAmount baseUnits={onChainAccount.availableBalanceBaseUnits} /></dd></div>
                  <div><dt>Pending confidential balance</dt><dd><ReserveAmount baseUnits={onChainAccount.pendingBalanceBaseUnits} /></dd></div>
                </dl>
                <p className="reserve-panel__note">{fundingStateDescription(onChainAccount.fundingState)}</p>
              </>
            ) : onChainAccount.status === "not_configured" ? (
              <p role="status">The wrapped-USDC mint or Payroll Program is not configured. On-chain reserve setup is unavailable.</p>
            ) : onChainAccount.status === "no_reserve" ? (
              <p role="status">No reserve signing address exists to reconcile.</p>
            ) : onChainAccount.status === "not_checked" ? (
              <p role="status">The on-chain reserve state could not be checked in this session.</p>
            ) : (
              <p role="alert">On-chain reserve state is not verified. Do not report the confidential reserve as ready or funded.</p>
            )}
          </section>

          {fundingAvailable ? (
            <section className="reserve-panel" aria-labelledby="reserve-funding-heading">
              <header className="reserve-panel__header">
                <h3 id="reserve-funding-heading">Fund the Reserve with ordinary USDC</h3>
                <p>
                  Enter the amount of Circle configured network USDC in your connected wallet.
                  Paylore checks the token accounts, asks your wallet to approve the
                  wrap, and verifies the finalized USDC debit, Token Wrap escrow
                  credit, and Reserve wrapped-USDC credit. A verified public credit
                  is not the same as a verified confidential balance.
                </p>
              </header>
              {pendingWrap ? (
                <>
                  <ol className="reserve-steps" aria-label="Reserve funding progress">
                    {FUNDING_STEPS.map((label, index) => {
                      const state = index < fundingStep ? "done" : index === fundingStep ? "current" : "upcoming";
                      return (
                        <li key={label} className="reserve-steps__item" data-state={state}
                          aria-current={state === "current" ? "step" : undefined}>
                          <span className="reserve-steps__marker" aria-hidden="true">{index + 1}</span>
                          <span>{label}</span>
                        </li>
                      );
                    })}
                  </ol>
                  <dl className="reserve-facts">
                    <div><dt>Amount in this funding operation</dt><dd><ReserveAmount baseUnits={pendingWrap.amountBaseUnits} /></dd></div>
                    <div className="reserve-facts__wide"><dt>Saved wrap signature</dt><dd><code>{pendingWrap.signature}</code></dd></div>
                  </dl>
                </>
              ) : (
                <div className="field reserve-funding__field">
                  <label htmlFor="reserve-ordinary-usdc-amount">Amount (USDC)</label>
                  <input
                    id="reserve-ordinary-usdc-amount"
                    name="reserve-ordinary-usdc-amount"
                    inputMode="decimal"
                    autoComplete="off"
                    value={fundingAmount}
                    disabled={busy || fundingBusy}
                    onChange={(event) => setFundingAmount(event.target.value)}
                    placeholder="0.00"
                    aria-describedby="reserve-ordinary-usdc-help"
                  />
                  <p id="reserve-ordinary-usdc-help" className="field__helper">
                    Current public wrapped-USDC balance: <ReserveAmount baseUnits={onChainAccount.publicBalanceBaseUnits} />.
                    Use up to six decimal places. Your wallet must approve the transaction and pay its network fees.
                  </p>
                </div>
              )}
              <div className="reserve-panel__status" aria-live="polite">
                {fundingBusy ? (
                  <p className="loading-indicator" role="status">
                    <span className="loading-indicator__icon" aria-hidden="true" />
                    {pendingWrap?.phase === "wrap_pending"
                      ? "Checking the finalized ordinary-USDC wrap transaction…"
                      : pendingWrap?.phase === "wrap_verified"
                        ? "Preparing the verified wrap for confidential deposit…"
                        : pendingWrap?.phase === "preapply"
                          ? "Applying the Reserve's earlier pending confidential balance…"
                          : pendingWrap?.phase === "deposit"
                            ? "Depositing wrapped USDC into the confidential pending balance…"
                            : pendingWrap?.phase === "apply"
                              ? "Applying the new confidential balance…"
                              : pendingWrap
                                ? "Verifying and continuing the submitted Reserve funding…"
                                : "Checking USDC and preparing the wallet transaction…"}
                  </p>
                ) : fundingNotice ? (
                  <div className="state-callout" data-state={fundingNotice.state}
                    role={fundingNotice.state === "error" ? "alert" : "status"}>
                    <span className="state-callout__signal" aria-hidden="true" />
                    <p>{fundingNotice.text}</p>
                  </div>
                ) : null}
              </div>
              <div className="reserve-panel__actions reserve-panel__actions--footer">
                <button className="button" type="button"
                  disabled={busy || fundingBusy || checkingOnChain} aria-busy={fundingBusy}
                  onClick={() => void fundReserveWithOrdinaryUsdc()}>
                  {fundingBusy ? "Working…" : pendingWrap ? "Continue confidential funding" : "Wrap USDC and fund Reserve"}
                </button>
              </div>
            </section>
          ) : null}

          {canInitialize ? (
            <section className="reserve-panel" aria-labelledby="reserve-setup-heading">
              <header className="reserve-panel__header">
                <h3 id="reserve-setup-heading">Reserve setup and recovery</h3>
              </header>
              <div className="reserve-setup">
                <div className="reserve-setup__item">
                  <h4>Confidential reserve account</h4>
                  <p>Creates or checks the reserve-owned Token-2022 account and the matching Paylore Program reserve state. It does not fund the Reserve.</p>
                  <div className="reserve-panel__actions">
                    <button
                      className="button"
                      disabled={
                        busy ||
                        fundingBusy ||
                        checkingOnChain ||
                        !gasTankAllowsReserveInitialization(gasTankPreflight.status)
                      }
                      aria-busy={busy && activeAction === "initialize_confidential"}
                      onClick={() => void run("initialize_confidential")}
                      type="button"
                    >
                      {setupSignature ? "Check reserve initialization status" : "Initialize confidential reserve"}
                    </button>
                  </div>
                </div>
                <div className="reserve-setup__item">
                  <h4>Encrypted key backup</h4>
                  <p>Opens the encrypted reserve signing-key backup on the server, confirms it matches this Reserve address, and restores custody from it. No key material is shown.</p>
                  <div className="reserve-panel__actions">
                    <button className="button button--secondary" disabled={busy || fundingBusy}
                      aria-busy={busy && activeAction === "restore"} onClick={() => void run("restore")} type="button">
                      Verify encrypted backup
                    </button>
                  </div>
                </div>
              </div>
              {setupBusy ? (
                <p className="loading-indicator reserve-panel__status" role="status">
                  <span className="loading-indicator__icon" aria-hidden="true" />
                  {activeAction === "restore"
                    ? "Verifying reserve signing-key backup…"
                    : setupPhase === "program_configure"
                      ? "Verifying the Paylore Program reserve…"
                      : "Configuring the reserve confidential account…"}
                </p>
              ) : null}
            </section>
          ) : null}
        </>
      ) : (
        <section className="reserve-panel" aria-labelledby="reserve-custody-heading">
          <header className="reserve-panel__header">
            <h2 id="reserve-custody-heading">Reserve key custody not configured</h2>
            <p>Configure encrypted custody for the reserve signing key. This action does not create or fund an on-chain confidential reserve.</p>
          </header>
          {busy && activeAction === "initialize" ? (
            <p className="loading-indicator" role="status">
              <span className="loading-indicator__icon" aria-hidden="true" />
              Configuring reserve signing-key custody…
            </p>
          ) : null}
          {canInitialize ? (
            <div className="reserve-panel__actions reserve-panel__actions--footer">
              <button className="button" disabled={busy || fundingBusy} aria-busy={busy} onClick={() => void run("initialize")} type="button">
                Configure reserve key custody
              </button>
            </div>
          ) : null}
        </section>
      )}
      <p className="reserve-privacy">
        <span className="reserve-privacy__icon" aria-hidden="true" />
        Paylore does not display reserve private keys, envelope secrets, provider API keys, database credentials, or session tokens.
      </p>
    </div>
  );
}
