"use client";

import { useRouter } from "next/navigation";
import { isWalletCancellation } from "../auth/walletErrors";
import { useState } from "react";
import { getBase58Decoder } from "@solana/kit";
import { findAuthenticatedWallet } from "./authenticated-wallet";
const PAYROLL_CLAIMS_PER_TRANSACTION = 2;
import { waitForDevnetFinality } from "./payroll-transaction-finality";

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
        `Prepare ${claims.length} Claim PDA entitlements for this payroll run? The workspace Gas Tank will pay the network fee up to the displayed limit. Your wallet must still approve the transaction and pays any Claim PDA rent. This does not send USDC or complete payroll settlement.`
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
        const sponsorshipResponse = await fetch(
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
        );
        const sponsorship = await sponsorshipResponse.json().catch(() => null) as {
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
        } | null;
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
          const reason = sponsorship?.error;
          if (reason === "gas_tank_insufficient_balance") {
            throw new Error("The workspace Gas Tank balance is too low to sponsor this transaction. Fund the Gas Tank, then retry the payroll commitment.");
          }
          if (reason === "gas_tank_not_initialized") {
            throw new Error("The workspace Gas Tank has not been initialized. Set it up before requesting sponsored payroll transactions.");
          }
          if (reason === "gas_tank_daily_sponsorship_limit") {
            throw new Error("The workspace Gas Tank sponsorship limit has been reached for the last 24 hours. Try again after the budget window resets.");
          }
          if (reason === "sponsorship_transaction_pending_finality") {
            throw new Error("An earlier sponsored transaction has been submitted and is awaiting finality. Paylore will not create another transaction while that attempt is unresolved.");
          }
          if (reason === "sponsorship_transaction_still_live" || reason === "gas_tank_operation_preparing") {
            throw new Error("A prepared Gas Tank transaction is still active. Do not retry or approve another transaction until the existing attempt is reconciled.");
          }
          if (reason === "previous_sponsored_transaction_failed_retry_allowed") {
            throw new Error("The earlier sponsored transaction finalized with an on-chain failure. Its actual network fee was recorded; you can safely retry the same payroll batch.");
          }
          if (reason === "payroll_run_already_committed") {
            throw new Error("This payroll run is already committed. Refresh to view its recorded state; Paylore will not prepare another transaction.");
          }
          if (reason === "gas_tank_operation_already_prepared" || reason === "gas_tank_operation_already_finalized") {
            throw new Error("An earlier sponsored attempt exists for this payroll batch. Refresh and reconcile that attempt before submitting another transaction.");
          }
          throw new Error("The Gas Tank could not prepare a permitted sponsored transaction. No arbitrary transaction was signed.");
        }
        const transaction = Uint8Array.from(
          atob(sponsorship.transactionBase64),
          (character) => character.charCodeAt(0)
        );
        setProgress(
          `Your wallet must approve transaction ${index + 1} of ${batchCount}. The Gas Tank pays a ${sponsorship.feeLamports} lamport network fee; your wallet remains the authority and pays Claim PDA rent.`
        );
        let result;
        try {
          [result] = await wallet.signAndSendTransaction({
            account: wallet.account,
            chain: "solana:devnet",
            transaction,
            options: { commitment: "confirmed" }
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
        await waitForDevnetFinality(transactionSignature);

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
          const resultBody = await response.json();
          throw new Error(
            resultBody.error === "payroll_program_not_configured"
              ? "The Devnet Payroll Program is not configured. No database completion was recorded."
              : `Transaction ${index + 1} finalized but its Claim PDA records could not be reconciled. Keep this signature and retry the idempotent submission: ${transactionSignature}`
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
          error instanceof Error && (
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
  return (
    <div>
      <button
        className="button"
        disabled={
          busy ||
          !programId ||
          !allocationCommitment ||
          claims.length === 0
        }
        aria-busy={busy}
        onClick={() => void submitClaims()}
        type="button"
      >
        {busy ? "Submitting Claim PDAs…" : "Submit Claim PDAs"}
      </button>
      {!programId ? (
        <p className="notice">
          Configure the verified Devnet Payroll Program ID before submitting
          payroll claims.
        </p>
      ) : null}
      {canCommit ? (
        <p className="notice">
          Sponsored network fees are limited to approved payroll Claim PDA
          creation. The manager wallet remains the authority and pays account
          rent.{" "}
          <a href={`/workspace/${workspaceId}/gas-tank`}>Manage Gas Tank</a>
        </p>
      ) : null}
      {progress ? <p role="status">{progress}</p> : null}
      {message ? (
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
  );
}
