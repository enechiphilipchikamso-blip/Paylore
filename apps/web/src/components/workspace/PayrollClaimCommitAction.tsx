"use client";

import { useRouter } from "next/navigation";
import { isWalletCancellation } from "../auth/walletErrors";
import { useState } from "react";
import { getBase58Decoder } from "@solana/kit";
import { findAuthenticatedWallet } from "./authenticated-wallet";
import { BusyActionButton } from "./BusyActionButton";
import { SOLANA_WALLET_CHAIN } from "./solana-network";
const PAYROLL_CLAIMS_PER_TRANSACTION = 2;
import { waitForTransactionFinality } from "./payroll-transaction-finality";
import {
  describeGasTankError,
  GAS_TANK_RETRYABLE_PENDING_CODES
} from "./gas-tank-error-messages";

/** Escrow accounts finalize across several Devnet transactions; resume preparation this many times. */
const ESCROW_PENDING_MAX_ATTEMPTS = 12;
const ESCROW_PENDING_RETRY_DELAY_MS = 5_000;
/** Outcomes where earlier work is recorded and the same action can be resumed. */
const PARTIAL_OUTCOME_CODES = new Set([
  "payroll_claim_escrow_setup_pending",
  "sponsorship_transaction_pending_finality",
  "sponsorship_transaction_still_live",
  "gas_tank_operation_preparing",
  "previous_sponsored_transaction_failed_retry_allowed"
]);

class PartialOutcomeError extends Error {}

type Claim = {
  claimId: string;
  contributorAddress: string;
  amountCommitment: string;
  amountCommitmentProof: string[];
  amountCommitmentLeafIndex: number;
};

export function PayrollClaimCommitAction({
  workspaceId,
  runId,
  walletAddress,
  programId,
  allocationCommitment,
  claims,
  canCommit
}: {
  workspaceId: string;
  runId: string;
  walletAddress: string;
  programId: string | null;
  allocationCommitment: string | null;
  claims: Claim[];
  canCommit: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [message, setMessage] = useState<{
    state: "success" | "error" | "partial";
    text: string;
  } | null>(null);

  async function submitClaims() {
    if (
      busy ||
      !canCommit ||
      !programId ||
      !allocationCommitment ||
      claims.length === 0 ||
      claims.some((claim) =>
        !/^[0-9a-f]{64}$/i.test(claim.amountCommitment) ||
        !Number.isSafeInteger(claim.amountCommitmentLeafIndex) ||
        claim.amountCommitmentLeafIndex < 0 ||
        !Array.isArray(claim.amountCommitmentProof) ||
        claim.amountCommitmentProof.length > 16 ||
        !claim.amountCommitmentProof.every((sibling) => /^[0-9a-f]{64}$/i.test(sibling))
      )
    ) {
      return;
    }
    if (
      !window.confirm(
        `Prepare ${claims.length} Claim PDA entitlements for this payroll run? The workspace Gas Tank pays the network fees and the rent for each confidential allocation account and Claim PDA. Your wallet must still approve the transaction as workspace authority. This does not send USDC or complete payroll settlement.`
      )
    ) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const wallet = await findAuthenticatedWallet(walletAddress);
      const claimsPerTransaction = claims.some((claim) => claim.amountCommitmentProof.length > 8)
        ? 1
        : PAYROLL_CLAIMS_PER_TRANSACTION;
      const batchCount = Math.ceil(claims.length / claimsPerTransaction);
      const decoder = getBase58Decoder();
      for (let index = 0; index < batchCount; index += 1) {
        const claimBatch = claims.slice(
          index * claimsPerTransaction,
          (index + 1) * claimsPerTransaction
        );
        setProgress(
          `Preparing batch ${index + 1} of ${batchCount}: the Gas Tank is creating the confidential allocation accounts and checking the sponsorship policy…`
        );
        let sponsorshipResponse: Response | null = null;
        let sponsorship: {
          status?: string;
          error?: string;
          submittedCount?: number;
          totalCount?: number;
          operationId?: string;
          transactionBase64?: string;
          signature?: string;
          feeLamports?: string;
          gasTankAddress?: string;
          claims?: Array<{ claimId: string; claimAddress: string }>;
        } | null = null;
        for (let attempt = 1; attempt <= ESCROW_PENDING_MAX_ATTEMPTS; attempt += 1) {
          sponsorshipResponse = await fetch(
            `/api/workspaces/${workspaceId}/payroll/runs/${runId}/sponsor`,
            {
              method: "POST",
              credentials: "same-origin",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({
                action: "prepare",
                claimIds: claimBatch.map((claim) => claim.claimId)
              })
            }
          ).catch(() => null);
          sponsorship = sponsorshipResponse
            ? await sponsorshipResponse.json().catch(() => null)
            : null;
          const stillPreparing =
            (sponsorship?.status === "pending" &&
              GAS_TANK_RETRYABLE_PENDING_CODES.has(sponsorship.error ?? "")) ||
            // A platform timeout means escrow setup outlived the request; its signatures are persisted and resumable.
            (sponsorshipResponse !== null && (sponsorshipResponse.status === 502 || sponsorshipResponse.status === 504) && !sponsorship);
          if (!stillPreparing || attempt === ESCROW_PENDING_MAX_ATTEMPTS) break;
          setProgress(
            `Batch ${index + 1} of ${batchCount}: confidential allocation accounts are awaiting Devnet finality (check ${attempt} of ${ESCROW_PENDING_MAX_ATTEMPTS - 1}). Paylore resumes automatically; keep this page open.`
          );
          await new Promise((resolve) => setTimeout(resolve, ESCROW_PENDING_RETRY_DELAY_MS));
        }
        if (!sponsorshipResponse) {
          throw new Error(describeGasTankError(null));
        }
        if (sponsorshipResponse.ok && sponsorship?.status === "reconciled") {
          if (!sponsorship.signature) {
            throw new Error("A prior sponsored transaction was reconciled without a transaction reference. Refresh the payroll run before continuing.");
          }
          setProgress(
            `Previously submitted transaction ${sponsorship.signature} is finalized and reconciled. No new transaction was sent for this batch.`
          );
          continue;
        }
        if (!sponsorshipResponse.ok || !sponsorship?.transactionBase64 ||
            !sponsorship.operationId || !sponsorship.signature ||
            !Array.isArray(sponsorship.claims) ||
            sponsorship.claims.length !== claimBatch.length) {
          const code = sponsorship?.error;
          const text = sponsorshipResponse.ok && !code
            ? "The Gas Tank returned an incomplete sponsored transaction. Nothing was signed by your wallet. Refresh and retry."
            : describeGasTankError(code, sponsorshipResponse.status);
          throw code && PARTIAL_OUTCOME_CODES.has(code) ? new PartialOutcomeError(text) : new Error(text);
        }
        const transaction = Uint8Array.from(
          atob(sponsorship.transactionBase64),
          (character) => character.charCodeAt(0)
        );
        setProgress(
          `Your wallet must approve transaction ${index + 1} of ${batchCount}. The Gas Tank pays the network fee and Claim PDA rent; your wallet remains the workspace authority.`
        );
        let result;
        try {
          [result] = await wallet.signAndSendTransaction({
            account: wallet.account,
            chain: SOLANA_WALLET_CHAIN,
            transaction
          });
        } catch (error) {
          if (isWalletCancellation(error)) {
            const cancellation = await fetch(
              `/api/workspaces/${workspaceId}/payroll/runs/${runId}/sponsor`,
              {
                method: "POST",
                credentials: "same-origin",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ action: "cancel", operationId: sponsorship.operationId })
              }
            ).catch(() => null);
            if (cancellation?.ok) {
              throw new Error("Transaction canceled in your wallet. No sponsored transaction was submitted. You can retry this batch.");
            }
            throw new Error("Your wallet canceled the request, but Paylore could not safely release the prepared sponsorship attempt. Refresh the payroll run and reconcile this attempt before retrying to avoid duplicate transactions.");
          }
          throw error;
        }
        const transactionSignature = decoder.decode(result.signature);
        if (transactionSignature !== sponsorship.signature) {
          throw new Error("The wallet-returned signature does not match the server-prepared sponsored transaction. Do not submit another transaction; reconcile this attempt first.");
        }
        setProgress(
          `Waiting for transaction ${index + 1} of ${batchCount} to finalize.`
        );
        await waitForTransactionFinality(transactionSignature);

        const response = await fetch(
          `/api/workspaces/${workspaceId}/payroll/runs/${runId}/commit`,
          {
            method: "POST",
            credentials: "same-origin",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              signature: transactionSignature,
              sponsorOperationId: sponsorship.operationId,
              claims: sponsorship.claims
            })
          }
        );
        if (!response.ok) {
          const resultBody = await response.json().catch(() => null) as { error?: string } | null;
          if (resultBody?.error === "payroll_program_not_configured") {
            throw new Error("The Devnet Payroll Program is not configured. No database completion was recorded.");
          }
          throw new PartialOutcomeError(
            `Transaction ${index + 1} finalized but its Claim PDA records could not be reconciled yet. Retry Submit Claim PDAs; Paylore reconciles the same finalized transaction instead of sending a new one. Signature: ${transactionSignature}`
          );
        }
      }
      setMessage({
        state: "success",
        text: "All Claim PDAs are finalized and reconciled. Contributor settlement is a separate step."
      });
      setProgress("");
      router.refresh();
    } catch (error) {
      setMessage({
        state:
          error instanceof PartialOutcomeError || error instanceof Error && (
            error.message.includes("is not finalized yet") ||
            error.message.includes("reconcile this attempt")
          )
            ? "partial"
            : "error",
        text:
          error instanceof Error
            ? error.message
            : "Payroll claim commitments could not be completed."
      });
    } finally {
      setBusy(false);
    }
  }

  if (!canCommit) return null;
  const blocked = !programId || !allocationCommitment || claims.length === 0;
  return (
    <section className="reserve-panel" aria-labelledby="payroll-claims-heading">
      <header className="reserve-panel__header">
        <h3 id="payroll-claims-heading">Submit Claim PDAs</h3>
        <p>
          Creates one confidential allocation account and one Claim PDA per
          allocation on Devnet. The workspace Gas Tank pays every network fee
          and account rent; your wallet approves only as workspace authority.
          No USDC moves in this step.
        </p>
      </header>
      {!programId ? (
        <div className="state-callout" data-state="error" role="alert">
          <span className="state-callout__signal" aria-hidden="true" />
          <p>Configure the verified Devnet Payroll Program ID before submitting payroll claims.</p>
        </div>
      ) : null}
      <div className="reserve-panel__status" aria-live="polite">
        {busy ? (
          <p className="loading-indicator" role="status">
            <span className="loading-indicator__icon" aria-hidden="true" />
            {progress || "Preparing the sponsored Claim PDA transaction…"}
          </p>
        ) : message ? (
          <div
            className="state-callout"
            data-state={message.state}
            role={message.state === "error" ? "alert" : "status"}
          >
            <span className="state-callout__signal" aria-hidden="true" />
            <p>{message.text}</p>
          </div>
        ) : null}
      </div>
      <div className="reserve-panel__actions reserve-panel__actions--footer">
        <a className="button button--secondary" href={`/workspace/${workspaceId}/gas-tank`}>
          Manage Gas Tank
        </a>
        <BusyActionButton
          className="button"
          busy={busy}
          disabled={blocked}
          onClick={() => void submitClaims()}
          type="button"
        >
          {busy
            ? "Submitting Claim PDAs…"
            : message?.state === "error" || message?.state === "partial"
              ? "Retry Submit Claim PDAs"
              : "Submit Claim PDAs"}
        </BusyActionButton>
      </div>
    </section>
  );
}
