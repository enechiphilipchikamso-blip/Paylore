"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

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
  const [message, setMessage] = useState<string | null>(null);

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
            ? "This run can no longer be cancelled because commitment has started."
            : "The run could not be cancelled. Its current status has not been changed by this message."
        );
        return;
      }
      router.refresh();
    } catch {
      setMessage(
        "The cancellation result could not be verified. Refresh the run before retrying."
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      {canCancel ? (
        <button
          className="button button--secondary"
          disabled={busy}
          onClick={() => void cancelRun()}
          type="button"
        >
          {busy ? "Cancelling…" : "Cancel before commitment"}
        </button>
      ) : null}
      {message ? (
        <div className="state-callout" data-state="partial" role="status">
          <span className="state-callout__signal" aria-hidden="true" />
          <p>{message}</p>
        </div>
      ) : null}
    </div>
  );
}
