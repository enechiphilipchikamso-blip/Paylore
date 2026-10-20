"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { getBase58Decoder } from "@solana/kit";
import { findAuthenticatedWallet } from "./authenticated-wallet";
import {
  buildPayrollClaimTransactions,
  PAYROLL_CLAIMS_PER_TRANSACTION
} from "./payroll-program-transaction";
import { waitForDevnetFinality } from "./payroll-transaction-finality";

type Claim = {
  claimId: string;
  contributorAddress: string;
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
      claims.length === 0
    ) {
      return;
    }
    if (
      !window.confirm(
        `Create or verify ${claims.length} Claim PDA entitlements for this payroll run? Your wallet will approve the Devnet transactions and pay applicable network fees and PDA rent. This does not send USDC or represent a completed payroll payout.`
      )
    ) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const wallet = await findAuthenticatedWallet(walletAddress);
      const batchCount = Math.ceil(
        claims.length / PAYROLL_CLAIMS_PER_TRANSACTION
      );
      const decoder = getBase58Decoder();
      for (let index = 0; index < batchCount; index += 1) {
        const claimBatch = claims.slice(
          index * PAYROLL_CLAIMS_PER_TRANSACTION,
          (index + 1) * PAYROLL_CLAIMS_PER_TRANSACTION
        );
        const [batch] = await buildPayrollClaimTransactions({
          authorityAddress: walletAddress,
          workspaceId,
          allocationCommitment,
          claims: claimBatch,
          programId,
          includeWorkspaceInitialization: true
        });
        if (!batch) {
          throw new Error("A payroll claim transaction could not be prepared.");
        }
        setProgress(
          `Approve transaction ${index + 1} of ${batchCount} in your wallet.`
        );
        const [result] = await wallet.signAndSendTransaction({
          account: wallet.account,
          chain: "solana:devnet",
          transaction: batch.transaction,
          options: { commitment: "confirmed" }
        });
        const transactionSignature = decoder.decode(result.signature);
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
              claims: batch.claimIds.map((claimId, claimIndex) => ({
                claimId,
                claimAddress: batch.claimAddresses[claimIndex]
              }))
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
          error instanceof Error && error.message.includes("is not finalized yet")
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
