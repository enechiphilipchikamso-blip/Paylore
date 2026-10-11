"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function ReserveActions({
  workspaceId,
  reserve,
  canInitialize
}: {
  workspaceId: string;
  reserve: {
    address: string;
    createdAt: string;
    updatedAt: string;
  } | null;
  canInitialize: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    state: "success" | "error" | "partial";
    text: string;
  } | null>(null);

  async function run(action: "initialize" | "restore") {
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/settings/reserve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ action })
        }
      );
      if (!response.ok) {
        setNotice({
          state: "error",
          text: action === "initialize"
            ? "Reserve initialization could not be completed. Please try again."
            : "The reserve backup could not be verified. Please try again."
        });
        return;
      }
      setNotice({
        state: "success",
        text: action === "initialize"
          ? "Reserve initialized successfully."
          : "The encrypted reserve backup was verified and restored."
      });
      router.refresh();
    } catch {
      setNotice({
        state: "error",
        text: "Reserve unavailable — try again. No private-key material is shown here."
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="reserve-actions">
      {notice ? (
        <div className="state-callout" data-state={notice.state} role={notice.state === "error" ? "alert" : "status"}>
          <span className="state-callout__signal" aria-hidden="true" />
          <p>{notice.text}</p>
        </div>
      ) : null}
      {busy ? (
        <p className="loading-indicator" role="status">
          <span className="loading-indicator__icon" aria-hidden="true" />
          Initializing…
        </p>
      ) : null}
      {reserve ? (
        <section className="reserve-summary">
          <h2>Reserve ready</h2>
          <dl className="billing-period">
            <div><dt>Reserve status</dt><dd>Ready</dd></div>
            <div><dt>Reserve public address</dt><dd><code>{reserve.address}</code></dd></div>
            <div><dt>Initialized</dt><dd>{new Date(reserve.createdAt).toLocaleString()}</dd></div>
            <div><dt>Last updated</dt><dd>{new Date(reserve.updatedAt).toLocaleString()}</dd></div>
          </dl>
          {canInitialize ? (
            <button
              className="button button--secondary"
              disabled={busy}
              onClick={() => void run("restore")}
              type="button"
            >
              Verify encrypted backup
            </button>
          ) : null}
        </section>
      ) : (
        <section className="reserve-summary">
          <h2>Reserve not initialized</h2>
          <p>Initialize the workspace reserve before payroll operations require it.</p>
          {canInitialize ? (
            <button
              className="button"
              disabled={busy}
              onClick={() => void run("initialize")}
              type="button"
            >
              Initialize reserve
            </button>
          ) : null}
        </section>
      )}
      <p className="notice">
        Paylore does not display reserve private keys, envelope secrets,
        provider API keys, database credentials, or session tokens.
      </p>
    </div>
  );
}
