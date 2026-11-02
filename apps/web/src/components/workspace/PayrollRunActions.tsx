"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { BusyActionButton } from "./BusyActionButton";

export function PayrollRunActions({
  workspaceId,
  runId,
  canCancel
}: {
  workspaceId: string;
  runId: string;
  canCancel: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    state: "success" | "error" | "partial";
    text: string;
  } | null>(null);

  async function cancelRun() {
    if (
      busy ||
      !canCancel ||
      !window.confirm(
        "Cancel this confirmed payroll run before any on-chain commitment is submitted? This cannot be undone."
      )
    ) {
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/payroll/runs/${runId}`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "cancel" })
        }
      );
      if (!response.ok) {
        setMessage(
          response.status === 409
            ? { state: "partial", text: "This run can no longer be cancelled because commitment has started." }
            : { state: "error", text: "The run could not be cancelled. Its current status has not been changed." }
        );
        return;
      }
      setMessage({ state: "success", text: "The payroll run was cancelled. No on-chain commitment was submitted." });
      router.refresh();
    } catch {
      setMessage({
        state: "partial",
        text: "The cancellation result could not be verified. Refresh the run before retrying."
      });
    } finally {
      setBusy(false);
    }
  }

  if (!canCancel && !message) return null;
  return (
    <section className="reserve-panel" aria-labelledby="payroll-cancel-heading">
      <header className="reserve-panel__header">
        <h3 id="payroll-cancel-heading">Cancel before commitment</h3>
        <p>
          A confirmed run can be cancelled only while no Claim PDA or escrow
          transaction has been submitted. Cancellation cannot be undone.
        </p>
      </header>
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
      {canCancel ? (
        <div className="reserve-panel__actions reserve-panel__actions--footer">
          <BusyActionButton
            className="button button--secondary"
            busy={busy}
            onClick={() => void cancelRun()}
            type="button"
          >
            {busy ? "Cancelling…" : "Cancel payroll run"}
          </BusyActionButton>
        </div>
      ) : null}
    </section>
  );
}
