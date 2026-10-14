"use client";

import { useCallback, useEffect, useState } from "react";

type DeletionState = {
  deletionRequestedAt: string | null;
  deletionScheduledAt: string | null;
  deletionCanceledAt: string | null;
} | null;

type DeletionBlockers = {
  gasTank: "not_configured" | "funds_remain" | "closure_unverified";
  reserve: boolean;
  outstandingPayroll: boolean;
};

type DeletionResponse = {
  state: DeletionState;
  audit: {
    outcome: string;
    blockerCode: string | null;
    requestedAt: string | null;
    scheduledAt: string | null;
    canceledAt: string | null;
    completedAt: string | null;
  } | null;
  blockers: DeletionBlockers;
  retention: {
    inactiveDays: number;
    retentionEligible: boolean;
    paidOrActive: boolean;
  };
};

const errorMessages: Record<string, string> = {
  gas_tank_funds_remain:
    "The Gas Tank still holds funds. Deletion is blocked until an approved, verified closure/refund path is available.",
  gas_tank_closure_unverified:
    "The Gas Tank has no verified closure/refund path. Deletion is blocked to protect workspace funds.",
  reserve_closure_unverified:
    "The confidential Reserve still exists and has no verified closure path. Deletion is blocked.",
  outstanding_payroll_obligations:
    "Outstanding payroll obligations remain. Resolve or settle them before deleting application data.",
  waiting_period:
    "The 72-hour pending period has not elapsed. Deletion cannot begin yet.",
  request_required:
    "Request deletion and wait 72 hours before final confirmation.",
  workspace_not_found:
    "This workspace could not be found. Refresh the page or return to workspaces."
};

function formatRemaining(scheduledAt: string, now: number) {
  const seconds = Math.max(
    0,
    Math.ceil((new Date(scheduledAt).getTime() - now) / 1000)
  );
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return `${hours}h ${minutes}m ${remainingSeconds}s`;
}

export function WorkspaceDeletionActions({
  workspaceId
}: {
  workspaceId: string;
}) {
  const [data, setData] = useState<DeletionResponse | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  const endpoint = `/api/workspaces/${workspaceId}/retention`;

  const refresh = useCallback(async () => {
    const response = await fetch(endpoint, { cache: "no-store" });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || !("state" in result)) {
      throw new Error("Workspace deletion status could not be loaded.");
    }
    setData(result as DeletionResponse);
    setLoading(false);
  }, [endpoint]);

  useEffect(() => {
    let active = true;
    void fetch(endpoint, { cache: "no-store" })
      .then(async (response) => {
        const result = await response.json().catch(() => null);
        if (!response.ok || !result || !("state" in result)) {
          throw new Error("Workspace deletion status could not be loaded.");
        }
        if (active) {
          setData(result as DeletionResponse);
          setLoading(false);
        }
      })
      .catch((error: unknown) => {
        if (!active) return;
        setLoading(false);
        setMessage(
          error instanceof Error
            ? error.message
            : "Workspace deletion status could not be loaded."
        );
      });
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, [endpoint]);

  async function perform(action: "request" | "cancel" | "finalize") {
    if (
      action === "finalize" &&
      !window.confirm(
        "This is a destructive action. Review the outstanding obligations and Gas Tank status. Paylore cannot erase blockchain state. Continue only if you understand what application data will be removed."
      )
    ) {
      return;
    }
    setBusy(true);
    setMessage(
      action === "finalize" ? "Deleting application data…" : ""
    );
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          action === "finalize"
            ? {
                action,
                confirmation: "DELETE WORKSPACE DATA"
              }
            : { action }
        )
      });
      const result = (await response.json().catch(() => null)) as
        | { status?: string; error?: string }
        | null;
      if (!response.ok) {
        throw new Error(
          (result?.error && errorMessages[result.error]) ||
            "Deletion could not be completed. Try again or contact support."
        );
      }
      if (action === "finalize") {
        setMessage(
          "Application data deleted. Solana transactions, program accounts, token accounts, and other blockchain state remain."
        );
        setData(null);
        return;
      }
      await refresh();
      setMessage(
        action === "request"
          ? "Deletion request pending. The 72-hour waiting period has started."
          : "Deletion request canceled."
      );
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : "Deletion could not be completed."
      );
    } finally {
      setBusy(false);
    }
  }

  const scheduledAt = data?.state?.deletionScheduledAt ?? null;
  const isPending = Boolean(
    scheduledAt && !data?.state?.deletionCanceledAt
  );
  const periodElapsed =
    isPending && scheduledAt !== null &&
    new Date(scheduledAt).getTime() <= now;
  const hasBlockers = Boolean(
    data?.blockers &&
    (data.blockers.outstandingPayroll ||
      data.blockers.reserve ||
      data.blockers.gasTank !== "not_configured")
  );
  const canFinalize = periodElapsed && !hasBlockers;

  return (
    <section className="surface-card" aria-labelledby="workspace-deletion-title">
      <h3 id="workspace-deletion-title">Delete workspace data</h3>
      <p>
        Deleting application data removes eligible Paylore records after the
        72-hour pending period and final obligation checks. It does not delete
        Solana transactions, program accounts, token accounts, or other
        blockchain state.
      </p>
      {loading ? <p role="status">Loading retention details…</p> : null}
      {data ? (
        <div className="state-callout" data-state={isPending ? "partial" : "info"}>
          <span className="state-callout__signal" aria-hidden="true" />
          {isPending && scheduledAt ? (
            <>
              <p>Deletion request pending</p>
              <p>
                {canFinalize
                  ? "Eligible for final confirmation"
                  : periodElapsed
                    ? data.blockers.outstandingPayroll
                      ? "Deletion blocked by outstanding obligations."
                      : "Gas Tank or confidential Reserve requires attention before deletion."
                    : `Time remaining: ${formatRemaining(scheduledAt, now)}`}
              </p>
            </>
          ) : (
            <p>No workspace deletion is currently pending.</p>
          )}
        </div>
      ) : null}
      {data?.blockers ? (
        <ul aria-label="Deletion checks">
          <li>
            {data.blockers.outstandingPayroll
              ? "Deletion blocked by outstanding obligations."
              : "No outstanding payroll obligations were found."}
          </li>
          <li>
            {data.blockers.gasTank === "not_configured"
              ? "No Gas Tank is configured."
              : data.blockers.gasTank === "funds_remain"
                ? "Gas Tank requires attention before deletion: funds remain."
                : "Gas Tank requires attention before deletion: closure is not verified."}
          </li>
          <li>
            {data.blockers.reserve
              ? "Confidential Reserve closure is not verified."
              : "No confidential Reserve is configured."}
          </li>
        </ul>
      ) : null}
      {data?.retention ? (
        <p>
          {data.retention.retentionEligible
            ? "Eligible for retention review after 365 days of inactivity; manual deletion still requires the 72-hour wait and final safety checks."
            : data.retention.paidOrActive
              ? "This workspace has an active or scheduled subscription. Paid-but-unused workspaces are not automatically deleted."
              : data.retention.inactiveDays < 365
                ? `${data.retention.inactiveDays} of 365 inactivity days have elapsed. Workspace data is never automatically deleted.`
                : "The 365-day inactivity period has elapsed, but eligibility checks are not satisfied. Workspace data is never automatically deleted."}
        </p>
      ) : null}
      {data?.audit?.outcome === "blocked" && data.audit.blockerCode ? (
        <p role="status">
          Last deletion check:{" "}
          {errorMessages[data.audit.blockerCode] ??
            "Deletion is blocked by a safety check."}
        </p>
      ) : null}
      <p>
        After 365 days from workspace closure, Paylore may remove a contributor&apos;s
        workspace application association once qualifying obligations are
        settled. This does not close the contributor&apos;s confidential account.
      </p>
      {message ? (
        <p role="status" aria-live="polite">{message}</p>
      ) : null}
      {data ? (
        <div className="form-actions">
          {!isPending ? (
            <button
              type="button"
              disabled={busy}
              onClick={() => void perform("request")}
            >
              {busy ? "Please wait…" : "Request deletion"}
            </button>
          ) : (
            <>
              {!periodElapsed ? (
                <button
                  type="button"
                  className="button-secondary"
                  disabled={busy}
                  onClick={() => void perform("cancel")}
                >
                  Cancel deletion request
                </button>
              ) : null}
              {periodElapsed && hasBlockers ? (
                <button
                  type="button"
                  className="button-secondary"
                  disabled={busy}
                  onClick={() => void refresh().catch((error: unknown) => {
                    setMessage(
                      error instanceof Error
                        ? error.message
                        : "Workspace deletion status could not be loaded."
                    );
                  })}
                >
                  Refresh deletion checks
                </button>
              ) : null}
              {canFinalize ? (
                <button
                  type="button"
                  className="button-danger"
                  disabled={busy}
                  onClick={() => void perform("finalize")}
                >
                  {busy ? "Deleting application data…" : "Delete workspace data"}
                </button>
              ) : null}
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}
