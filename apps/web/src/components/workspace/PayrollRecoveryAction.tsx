"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type RecoveryReason =
  | "incorrect_allocation"
  | "contributor_left_before_claim"
  | "payroll_correction"
  | "other";

type RecoveryPhase = "proof_setup" | "reserve_balance_apply" | "recovery";

const RECOVERY_REASON_OPTIONS: Array<{ value: RecoveryReason; label: string }> = [
  { value: "incorrect_allocation", label: "Incorrect allocation" },
  { value: "contributor_left_before_claim", label: "Contributor left before claim" },
  { value: "payroll_correction", label: "Payroll correction" },
  { value: "other", label: "Other" }
];

const RECOVERY_REASON_VALUES: ReadonlySet<string> = new Set(
  RECOVERY_REASON_OPTIONS.map((option) => option.value)
);

function isRecoveryReason(value: string): value is RecoveryReason {
  return RECOVERY_REASON_VALUES.has(value);
}

export function PayrollRecoveryAction({
  workspaceId,
  runId,
  allocationId,
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
  const [pendingPhase, setPendingPhase] = useState<RecoveryPhase | null>(null);
  const [reconciliationPending, setReconciliationPending] = useState(false);
  const [message, setMessage] = useState<{
    state: "success" | "error" | "partial";
    text: string;
  } | null>(null);

  async function submitRecovery() {
    if (busy || !canRecover) return;
    const recoveryNote = reason === "other" ? note.trim() || null : null;
    const checking = reconciliationPending || pendingSignature !== null;

    if (!checking && (!reason || (reason === "other" && !recoveryNote))) {
      setMessage({
        state: "error",
        text: "Choose a recovery reason. Add a note when the reason is Other."
      });
      return;
    }
    if (!checking && !window.confirm(
      "Recover this unclaimed allocation by moving its confidential USDC from the claim escrow back to the workspace reserve. The Claim PDA will become RECOVERED only in the same transaction as the transfer. This action cannot be reversed."
    )) return;

    setBusy(true);
    setMessage(null);
    setProgress(checking
      ? "Checking the existing recovery attempt…"
      : "Preparing confidential reserve recovery…");

    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/payroll/runs/${runId}/allocations/${allocationId}/recovery`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            reason: reason || "payroll_correction",
            note: reason === "other" ? recoveryNote : null,
            signature: pendingSignature,
            phase: pendingPhase
          })
        }
      );
      const result = await response.json().catch(() => null) as {
        status?: string;
        signature?: string | null;
        phase?: RecoveryPhase | null;
        error?: string;
        message?: string;
        warning?: string;
      } | null;

      if (response.status === 202 || result?.status === "pending") {
        setPendingSignature(result?.signature ?? pendingSignature);
        setPendingPhase(result?.phase ?? pendingPhase ?? "recovery");
        setReconciliationPending(true);
        setProgress("");
        setMessage({
          state: "partial",
          text: result?.message ??
            "Recovery is still being reconciled. Do not start another recovery. Check the existing attempt again."
        });
        return;
      }

      if (result?.status === "retry_ready") {
        setPendingSignature(null);
        setPendingPhase(null);
        setReconciliationPending(false);
        setProgress("");
        setMessage({
          state: "partial",
          text: result.message ??
            "The previous recovery transfer did not finalize. The allocation remains unclaimed; review its state before retrying."
        });
        router.refresh();
        return;
      }

      if (response.ok &&
          (result?.status === "recovered" || result?.status === "already_reconciled") &&
          result.valueTransferred !== false) {
        setPendingSignature(null);
        setPendingPhase(null);
        setReconciliationPending(false);
        setProgress("");
        setMessage({
          state: "success",
          text: result.status === "already_reconciled"
            ? "The confidential reserve restoration was already reconciled. The recovery record is up to date."
            : "Confidential USDC was restored to the workspace reserve and the recovery was recorded."
        });
        router.refresh();
        return;
      }

      if (!response.ok) {
        if (response.status >= 500 || result?.error === "payroll_recovery_submission_failed") {
          setReconciliationPending(true);
          setPendingPhase("recovery");
          setProgress("");
          setMessage({
            state: "partial",
            text: "Paylore could not determine the final recovery result yet. Check the existing recovery status before starting another recovery."
          });
        } else {
          setProgress("");
          setMessage({
            state: "error",
            text: result?.error === "workspace_busy"
              ? "Another payroll claim or recovery is being reconciled for this workspace. Check again after it finishes."
              : result?.error === "payroll_allocation_not_recoverable"
                ? "This allocation is no longer eligible for recovery."
                : "The recovery request could not be completed. Review the allocation state and try again."
          });
        }
        return;
      }

      setProgress("");
      setMessage({
        state: "partial",
        text: "The recovery result is not yet authoritative. Check the existing recovery status before starting another recovery."
      });
      setReconciliationPending(true);
      setPendingPhase("recovery");
    } catch {
      setProgress("");
      setReconciliationPending(true);
      setPendingPhase("recovery");
      setMessage({
        state: "partial",
        text: "The recovery response was interrupted. The server may already have submitted the transfer; check the existing recovery status before starting another recovery."
      });
    } finally {
      setBusy(false);
    }
  }

  if (!canRecover) return null;
  const checking = reconciliationPending || pendingSignature !== null;

  return (
    <details className="payroll-recovery-action">
      <summary>Review recovery</summary>
      <p className="notice">
        Paylore restores the exact unclaimed allocation to the workspace confidential reserve.
        A recovery is complete only after the confidential transfer, finalized Claim PDA state,
        balance reconciliation, ledger entry and contributor notice agree.
      </p>
      <label>
        Recovery reason
        <select
          disabled={busy || checking}
          onChange={(event) => {
            const value = event.currentTarget.value;
            setReason(value === "" || isRecoveryReason(value) ? value : "");
          }}
          value={reason}
        >
          <option value="">Choose a reason</option>
          {RECOVERY_REASON_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>{option.label}</option>
          ))}
        </select>
      </label>
      {reason === "other" ? (
        <label>
          Explain the reason
          <textarea
            disabled={busy || checking}
            maxLength={500}
            onChange={(event) => setNote(event.target.value)}
            required
            value={note}
          />
        </label>
      ) : null}
      {pendingSignature ? (
        <p>
          Existing recovery signature: <code>{pendingSignature}</code>
        </p>
      ) : null}
      <button
        className="button button--secondary"
        disabled={busy}
        onClick={() => void submitRecovery()}
        type="button"
      >
        {busy
          ? (checking ? "Checking recovery…" : "Recovering unclaimed payroll…")
          : checking
            ? "Check recovery status"
            : "Confirm confidential recovery"}
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
