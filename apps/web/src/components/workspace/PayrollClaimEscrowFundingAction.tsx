"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { describeClientError } from "./client-error-message";
import { describeGasTankError } from "./gas-tank-error-messages";

type FundingStatus = "funded" | "pending" | "retry_ready" | "workspace_busy";

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
        error?: string;
      } | null;
      if (response.ok && result?.status === "funded") {
        setPending(false);
        setMessage({
          state: "success",
          text: result.warning === "proof_context_cleanup_pending"
            ? `The claim escrow is funded and verified. Proof-context cleanup is still pending. ${result.signature ? `Transaction: ${result.signature}` : ""}`
            : `The claim escrow is funded and verified. ${result.signature ? `Transaction: ${result.signature}` : ""}`
        });
        router.refresh();
        return;
      }
      if (result?.status === "pending") {
        setPending(true);
        setMessage({
          state: "partial",
          text: `Escrow funding is still being reconciled. Retry this same action to check the existing operation; do not start another transfer.${result.signature ? ` Transaction: ${result.signature}` : ""}`
        });
        return;
      }
      if (result?.status === "retry_ready") {
        setPending(false);
        setMessage({
          state: "error",
          text: "The funding transaction did not finalize. The allocation remains unclaimed and no escrow funding was recorded. Review the reserve balance before retrying."
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
      setPending(response.status >= 500);
      setMessage({
        state: response.status >= 500 ? "partial" : "error",
        text: result?.error
          ? describeGasTankError(result.error, response.status)
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
        {busy ? "Funding claim escrow…" : pending ? "Check escrow funding" : "Fund claim escrow"}
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
