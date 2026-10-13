"use client";

import Link from "next/link";
import { useState } from "react";

type PayrollPreview = {
  rows: Array<{
    rowNumber: number;
    value: {
      displayName: string;
      identityWalletAddress: string;
      amountUsdc: string;
    } | null;
    errors: string[];
  }>;
  validCount: number;
  errorCount: number;
  totalUsdc: string;
};

type PreviewResponse = {
  status: "preview_ready" | "review_required";
  importDigest: string;
  preview: PayrollPreview;
};

export function PayrollRunManager({
  workspaceId,
  fileLimitBytes = 5 * 1024 * 1024
}: {
  workspaceId: string;
  fileLimitBytes?: number;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [idempotencyKey, setIdempotencyKey] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    state: "success" | "error" | "partial";
    text: string;
  } | null>(null);

  async function submit(action: "preview" | "confirm") {
    if (!file || busy) return;
    if (action === "confirm" && (!preview || !idempotencyKey)) return;
    setBusy(true);
    setNotice(null);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("action", action);
      if (action === "confirm" && preview && idempotencyKey) {
        form.set("previewDigest", preview.importDigest);
        form.set("idempotencyKey", idempotencyKey);
      }
      const response = await fetch(
        `/api/workspaces/${workspaceId}/payroll/runs`,
        {
          method: "POST",
          credentials: "same-origin",
          body: form
        }
      );
      const result = await response.json();
      if (action === "preview") {
        if (!result.preview || !result.importDigest) {
          setPreview(null);
          setNotice({
            state: "error",
            text: "The payroll file could not be previewed. Correct the file and try again."
          });
          return;
        }
        setPreview(result as PreviewResponse);
        setIdempotencyKey(crypto.randomUUID());
        if (!response.ok) {
          setNotice({
            state: "partial",
            text: "Review and correct every row before confirming this payroll."
          });
        }
        return;
      }

      if (!response.ok) {
        setNotice({
          state: "error",
          text: response.status === 409
            ? "The confirmed payroll no longer matches the preview. Preview the file again before confirming."
            : "The payroll run could not be saved. No successful submission is assumed; you can safely retry."
        });
        return;
      }
      setNotice({
        state: "partial",
        text: result.duplicate
          ? "This confirmed payroll already exists. Its on-chain commitment is still pending."
          : "Manager confirmation is recorded. The payroll run is saved, but its on-chain commitment has not been submitted."
      });
      setPreview(null);
      setFile(null);
      setIdempotencyKey(null);
      window.location.reload();
    } catch {
      setNotice({
        state: "error",
        text: "The payroll request could not be completed. Check the run list before retrying."
      });
    } finally {
      setBusy(false);
    }
  }

  function confirmRun() {
    if (!preview || preview.preview.errorCount > 0) return;
    const accepted = window.confirm(
      `Confirm this payroll draft for ${preview.preview.totalUsdc} USDC across ${preview.preview.validCount} contributors? This records your approval. It does not yet transfer funds or submit an on-chain commitment.`
    );
    if (accepted) void submit("confirm");
  }

  return (
    <section className="surface-card import-card" aria-labelledby="payroll-upload-title">
      <h2 id="payroll-upload-title">Create payroll run</h2>
      <p>
        Upload a CSV or XLSX allocation file. Every row must match an active
        contributor identity wallet in this workspace. Uploaded files are
        processed in memory and are not retained.
      </p>
      <label className="field">
        <span>Payroll file (CSV or XLSX; up to 5 MB)</span>
        <input
          accept=".csv,.xlsx"
          disabled={busy}
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setPreview(null);
            setIdempotencyKey(null);
            setNotice(null);
          }}
          type="file"
        />
      </label>
      {file && file.size > fileLimitBytes ? (
        <p role="alert">This file exceeds the 5 MB limit.</p>
      ) : null}
      <button
        className="button"
        disabled={!file || file.size > fileLimitBytes || busy}
        onClick={() => void submit("preview")}
        type="button"
      >
        {busy ? "Processing…" : "Preview payroll"}
      </button>

      {notice ? (
        <div
          className="state-callout"
          data-state={notice.state}
          role={notice.state === "error" ? "alert" : "status"}
        >
          <span className="state-callout__signal" aria-hidden="true" />
          <p>{notice.text}</p>
        </div>
      ) : null}

      {preview ? (
        <div className="import-preview">
          <h3>Review payroll preview</h3>
          <ul className="import-summary">
            <li>Valid allocations: {preview.preview.validCount}</li>
            <li>Rows requiring correction: {preview.preview.errorCount}</li>
            <li>Total: {preview.preview.totalUsdc} USDC</li>
          </ul>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Row</th>
                  <th scope="col">Contributor</th>
                  <th scope="col">Identity wallet</th>
                  <th scope="col">USDC</th>
                  <th scope="col">Validation</th>
                </tr>
              </thead>
              <tbody>
                {preview.preview.rows.map((row) => (
                  <tr key={row.rowNumber}>
                    <td>{row.rowNumber}</td>
                    <td>{row.value?.displayName ?? "—"}</td>
                    <td>{row.value?.identityWalletAddress ?? "—"}</td>
                    <td>{row.value?.amountUsdc ?? "—"}</td>
                    <td>{row.errors.length ? row.errors.join(" ") : "Ready"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="notice">
            Confirming saves the approved allocation snapshot and an idempotent
            payroll run. On-chain commitment and settlement are separate steps
            and are not represented as complete here.
          </p>
          <button
            className="button"
            disabled={
              busy ||
              preview.preview.errorCount > 0 ||
              preview.preview.validCount === 0
            }
            onClick={confirmRun}
            type="button"
          >
            Confirm payroll draft
          </button>
          <button
            className="button button--secondary"
            disabled={busy}
            onClick={() => {
              setPreview(null);
              setIdempotencyKey(null);
              setNotice(null);
            }}
            type="button"
          >
            Cancel preview
          </button>
        </div>
      ) : null}
      <Link className="button button--secondary" href={`/workspace/${workspaceId}`}>
        Back to workspace
      </Link>
    </section>
  );
}
