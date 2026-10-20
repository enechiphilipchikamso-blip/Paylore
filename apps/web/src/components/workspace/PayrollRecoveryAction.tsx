"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { getBase58Decoder } from "@solana/kit";
import { findAuthenticatedWallet } from "./authenticated-wallet";
import { buildPayrollRecoveryTransaction } from "./payroll-program-transaction";
import { waitForDevnetFinality } from "./payroll-transaction-finality";

type RecoveryReason =
  | "incorrect_allocation"
  | "contributor_left_before_claim"
  | "payroll_correction"
  | "other";

const RECOVERY_REASON_OPTIONS: Array<{
  value: RecoveryReason;
  label: string;
}> = [
  { value: "incorrect_allocation", label: "Incorrect allocation" },
  {
    value: "contributor_left_before_claim",
    label: "Contributor left before claim"
  },
  { value: "payroll_correction", label: "Payroll correction" },
  { value: "other", label: "Other" }
];

const RECOVERY_REASON_VALUES: ReadonlySet<string> = new Set(
  RECOVERY_REASON_OPTIONS.map((option) => option.value)
);

function isRecoveryReason(value: string): value is RecoveryReason {
  return RECOVERY_REASON_VALUES.has(value);
}

async function createReasonCommitment(
  reason: RecoveryReason,
  note: string | null
) {
  const payload = `paylore:recovery:v1:${JSON.stringify({ reason, note })}`;
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(payload)
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
}

export function PayrollRecoveryAction({
  workspaceId,
  runId,
  allocationId,
  claimId,
  claimAddress,
  contributorAddress,
  walletAddress,
  programId,
  canRecover
}: {
  workspaceId: string;
  runId: string;
  allocationId: string;
  claimId: string;
  claimAddress: string;
  contributorAddress: string;
  walletAddress: string;
  programId: string | null;
  canRecover: boolean;
}) {
  const router = useRouter();
  const [reason, setReason] = useState<RecoveryReason | "">("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const [pendingSignature, setPendingSignature] = useState<string | null>(null);
  const [message, setMessage] = useState<{
    state: "success" | "error" | "partial";
    text: string;
  } | null>(null);

  async function submitRecovery() {
    if (busy || !canRecover || !programId) return;
    const recoveryNote = reason === "other" ? note.trim() || null : null;
    if (!pendingSignature && (!reason || (reason === "other" && !recoveryNote))) {
      setMessage({
        state: "error",
        text: "Choose a recovery reason. Add a note when the reason is Other."
      });
      return;
    }
    if (
      !pendingSignature &&
      !window.confirm(
        "This permanently changes the Claim PDA to RECOVERED and removes the entitlement from the claim flow. The current payroll program does not transfer USDC or restore a confidential reserve. This is not a completed financial recovery. Continue only if you intend to cancel this unclaimed entitlement."
      )
    ) {
      return;
    }

    setBusy(true);
    setMessage(null);
    try {
      let transactionSignature = pendingSignature;
      if (!transactionSignature) {
        if (!reason) {
          throw new Error("Choose a recovery reason before continuing.");
        }
        const wallet = await findAuthenticatedWallet(walletAddress);
        const recoveryReasonCommitment = await createReasonCommitment(
          reason,
          recoveryNote
        );
        const transaction = await buildPayrollRecoveryTransaction({
          authorityAddress: walletAddress,
          contributorAddress,
          workspaceId,
          claimId,
          recoveryReasonCommitment,
          programId
        });
        setProgress("Approve the recovery state change in your wallet.");
        const [result] = await wallet.signAndSendTransaction({
          account: wallet.account,
          chain: "solana:devnet",
          transaction: transaction.transaction,
          options: { commitment: "confirmed" }
        });
        transactionSignature = getBase58Decoder().decode(result.signature);
        setPendingSignature(transactionSignature);
      }

      setProgress("Waiting for the recovery transaction to finalize.");
      await waitForDevnetFinality(transactionSignature);
      setProgress("Reconciling the finalized recovery on the server.");
      const response = await fetch(
        `/api/workspaces/${workspaceId}/payroll/runs/${runId}/allocations/${allocationId}/recovery`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            signature: transactionSignature,
            reason,
            note: recoveryNote
          })
        }
      );
      if (!response.ok) {
        throw new Error(
          `The recovery transaction finalized but could not be reconciled. Keep this signature and retry reconciliation: ${transactionSignature}`
        );
      }
      setPendingSignature(null);
      setProgress("");
      setMessage({
        state: "success",
        text: "The Claim PDA state change is finalized and recorded. No USDC transfer or reserve restoration occurred."
      });
      router.refresh();
    } catch (error) {
      setProgress("");
      setMessage({
        state:
          error instanceof Error && error.message.includes("is not finalized yet")
            ? "partial"
            : "error",
        text:
          error instanceof Error
            ? error.message
            : "The payroll recovery state change could not be completed."
      });
    } finally {
      setBusy(false);
    }
  }

  if (!canRecover) return null;
  return (
    <details className="payroll-recovery-action">
      <summary>Review recovery</summary>
      <div className="notice" role="note">
        <strong>Financial recovery is unavailable.</strong> Paylore will not
        change the Claim PDA or allocation until reserve restoration can be
        verified.
      </div>
      <label>
        Recovery reason
        <select
          disabled={busy || pendingSignature !== null}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setReason(
              value === "" || isRecoveryReason(value) ? value : ""
            );
          }}
          value={reason}
        >
          <option value="">Choose a reason</option>
          {RECOVERY_REASON_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {reason === "other" ? (
        <label>
          Explain the reason
          <textarea
            disabled={busy || pendingSignature !== null}
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
            required
            value={note}
          />
        </label>
      ) : null}
      {pendingSignature ? (
        <p>
          A recovery transaction is awaiting reconciliation. Retrying will use
          the same signature and will not submit another transaction:{" "}
          <code>{pendingSignature}</code>
        </p>
      ) : null}
      <button
        className="button button--secondary"
        disabled
        onClick={() => void submitRecovery()}
        type="button"
      >
        Recovery unavailable
      </button>
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
    </details>
  );
}
