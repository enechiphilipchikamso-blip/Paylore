"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { describeClientError } from "./client-error-message";
import { describeGasTankError } from "./gas-tank-error-messages";
import { describeFundingPending } from "./payroll-claim-escrow-funding-messages";

type FundingStatus = "funded" | "pending" | "retry_ready" | "workspace_busy";

/** Error codes raised after a funding transaction exists, so its result must be checked, not repeated. */
const FUNDING_OUTCOME_UNKNOWN_CODES: ReadonlySet<string> = new Set([
  "escrow_funding_transaction_not_verified",
  "escrow_funding_claim_state_not_verified",
  "payroll_claim_escrow_funding_conflict"
]);

export function PayrollClaimEscrowFundingAction({
  workspaceId,
  runId,
  allocationId,
  initiallyPending = false
}: {
  workspaceId: string;
  runId: string;
  allocationId: string;
  initiallyPending?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState(initiallyPending);
  const [message, setMessage] = useState<{
    state: "success" | "error" | "partial";
    text: string;
  } | null>(null);

  async function fundEscrow() {
    if (busy) return;
    if (!pending && !window.confirm(
      "Fund this unclaimed allocation by moving its exact amount from the workspace Confidential Payroll Reserve into its per-allocation claim escrow. Paylore does not mark the allocation claimed or recovered. Recovery remains available only while the finalized Claim PDA is unclaimed."
    )) return;

    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/payroll/runs/${runId}/allocations/${allocationId}/fund-escrow`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: "{}"
        }
      );
      const result = await response.json().catch(() => null) as {
        status?: FundingStatus;
        signature?: string;
        warning?: string;
        stage?: string;
        error?: string;
      } | null;
      if (response.ok && result?.status === "funded") {
        const cleanupPending = result.warning === "proof_context_cleanup_pending";
        setPending(cleanupPending);
        setMessage(cleanupPending
          ? { state: "partial", text: describeFundingPending("proof_cleanup_pending", result.signature) }
          : {
              state: "success",
              text: `The claim escrow is funded and verified. ${result.signature ? `Transaction: ${result.signature}` : ""}`.trim()
            });
        router.refresh();
        return;
      }
      if (result?.status === "pending") {
        setPending(true);
        setMessage({
          state: "partial",
          text: describeFundingPending(result.stage, result.signature)
        });
        return;
      }
      if (result?.status === "retry_ready") {
        setPending(false);
        setMessage({
          state: "error",
          text: "The funding attempt did not finalize and no transfer was recorded, so no funds moved. The hold on this allocation was released; you can fund the escrow again."
        });
        router.refresh();
        return;
      }
      if (result?.status === "workspace_busy") {
        setPending(true);
        setMessage({
          state: "partial",
          text: "A claim, recovery, or reserve operation is already in progress for this workspace. Check this same operation again after it finishes."
        });
        return;
      }
      // The funding outcome is unknown only when the server gave no readable
      // reason (platform timeout, crash) or named a code that says a funding
      // transaction already exists. Any other typed rejection happened before
      // anything was submitted: show its real reason and keep the action usable.
      const outcomeUnknown = result?.error
        ? FUNDING_OUTCOME_UNKNOWN_CODES.has(result.error)
        : response.status >= 500;
      setPending(outcomeUnknown);
      setMessage({
        state: outcomeUnknown ? "partial" : "error",
        text: result?.error
          ? describeGasTankError(result.error, response.status)
          : response.status >= 500
            ? `The server's answer could not be read (HTTP ${response.status}), so the funding result is not known. Check the existing operation before starting another transfer.`
            : `Claim escrow funding could not be completed (HTTP ${response.status}).`
      });
    } catch (error) {
      setPending(true);
      setMessage({
        state: "partial",
        text: describeClientError(
          error,
          "Claim escrow funding",
          "The funding response was interrupted. Check the existing operation before retrying."
        )
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="payroll-claim-escrow-funding-action">
      <button
        className="button button--secondary"
        type="button"
        disabled={busy}
        aria-busy={busy}
        onClick={() => void fundEscrow()}
      >
        {busy ? (pending ? "Checking funding…" : "Funding claim escrow…") : pending ? "Check funding" : "Fund claim escrow"}
      </button>
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
