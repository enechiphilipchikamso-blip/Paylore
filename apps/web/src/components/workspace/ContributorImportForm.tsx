"use client";

import Link from "next/link";
import { useState } from "react";
import { BusyActionButton } from "./BusyActionButton";
import type { ContributorImportResult } from "../../server/contributors-parser";
import { describeClientError } from "./client-error-message";

function describeImportError(code: string | undefined, status: number): string {
  switch (code) {
    case "authentication_required": return "Your session has ended. Sign in again before importing contributors.";
    case "workspace_access_denied": return "Only a workspace administrator can import contributors.";
    case "workspace_read_only": return "Contributor imports are paused while this workspace subscription is inactive.";
    case "file_too_large": return "The selected file is larger than the 5 MB upload limit.";
    case "file_required": return "Choose a CSV or XLSX file before starting the import.";
    case "file_could_not_be_processed": return "The file format or contents could not be processed. Check the CSV/XLSX structure and retry.";
    case "request_not_allowed": return "The request failed Paylore's origin check. Reload the page and retry.";
    case "invalid_contributors": return "The contributor preview is invalid. Review the file and create a new preview.";
    case "invalid_contributor_wallet": return "Each contributor must have a valid matching identity and payout wallet.";
    case "duplicate_contributor_wallet": return "One or more contributor wallets already exist in this workspace.";
    case "contributor_create_failed": return "Paylore could not save the contributor records. Refresh the directory before retrying.";
    default: return code
      ? `Contributor import was rejected (reference: ${code}).`
      : `Contributor import could not be completed (HTTP ${status}).`;
  }
}

export function ContributorImportForm({
  workspaceId
}: {
  workspaceId: string;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<ContributorImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    state: "success" | "error" | "partial";
    text: string;
  } | null>(null);

  async function createPreview() {
    if (!file) return;
    setBusy(true);
    setNotice(null);
    try {
      const form = new FormData();
      form.set("file", file);
      const response = await fetch(
        `/api/workspaces/${workspaceId}/contributors/import`,
        { method: "POST", credentials: "same-origin", body: form }
      );
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { error?: string } | null;
        setPreview(null);
        setNotice({
          state: "error",
          text: describeImportError(result?.error, response.status)
        });
        return;
      }
      const result = await response.json() as ContributorImportResult;
      setPreview(result);
      if (result.errorCount > 0) {
        setNotice({
          state: "partial",
          text: "Some rows could not be imported. Review the errors, correct the file, and upload again."
        });
      }
    } catch (error) {
      setPreview(null);
      setNotice({
        state: "error",
        text: describeClientError(
          error,
          "Contributor file preview",
          "The file could not be processed. Check its format and try again."
        )
      });
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!preview || preview.validCount === 0) return;
    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/contributors`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            contributors: preview.rows.flatMap((row) => row.value ? [row.value] : [])
          })
        }
      );
      if (!response.ok) {
        const result = await response.json().catch(() => null) as { error?: string } | null;
        setNotice({
          state: "error",
          text: describeImportError(result?.error, response.status)
        });
        return;
      }
      setNotice({
        state: preview.errorCount > 0 ? "partial" : "success",
        text: preview.errorCount > 0
          ? "Some rows could not be imported. Review the errors, correct the file, and upload again."
          : "Contributors imported successfully."
      });
      setPreview(null);
      setFile(null);
    } catch (error) {
      setNotice({
        state: "error",
        text: describeClientError(
          error,
          "Contributor import",
          "The contributor records could not be saved."
        )
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="surface-card import-card">
      <p>Upload a CSV or XLSX file to prepare contributor records for this workspace.</p>
      <label className="field">
        <span>Choose file (CSV, XLSX)</span>
        <input
          accept=".csv,.xlsx"
          onChange={(event) => {
            setFile(event.target.files?.[0] ?? null);
            setPreview(null);
            setNotice(null);
          }}
          type="file"
        />
      </label>
      <BusyActionButton
        busy={busy}
        className="button"
        disabled={!file}
        onClick={() => void createPreview()}
        type="button"
      >
        {busy ? "Preparing preview…" : "Preview import"}
      </BusyActionButton>

      {notice ? (
        <div className="state-callout" data-state={notice.state} role={notice.state === "error" ? "alert" : "status"}>
          <span className="state-callout__signal" aria-hidden="true" />
          <p>{notice.text}</p>
        </div>
      ) : null}

      {busy ? (
        <p className="loading-indicator" role="status">
          <span className="loading-indicator__icon" aria-hidden="true" />
          Importing…
        </p>
      ) : null}

      {preview ? (
        <div className="import-preview">
          <h2>Preview import</h2>
          <ul className="import-summary">
            <li>Valid rows: {preview.validCount}</li>
            <li>Rows with errors: {preview.errorCount}</li>
            <li>Duplicate wallets: {preview.duplicateWalletCount}</li>
          </ul>
          <div className="table-scroll">
            <table>
              <thead>
                <tr><th scope="col">Row</th><th scope="col">Name</th><th scope="col">Role</th><th scope="col">Identity wallet</th><th scope="col">Result</th></tr>
              </thead>
              <tbody>
                {preview.rows.map((row) => (
                  <tr key={row.rowNumber}>
                    <td>{row.rowNumber}</td>
                    <td>{row.value?.displayName ?? "—"}</td>
                    <td>{row.value?.role === "finance_auditor" ? "Finance/Auditor" : row.value ? "Contributor" : "—"}</td>
                    <td>{row.value?.identityWalletAddress ?? "—"}</td>
                    <td>{row.errors.length ? row.errors.join(" ") : "Ready"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="notice">
            The effective payout address must match the verified identity wallet. Finance/Auditor is read-only. Uploaded spreadsheet files are not retained by default.
          </p>
          <BusyActionButton
            busy={busy}
            className="button"
            disabled={preview.validCount === 0}
            onClick={() => void commit()}
            type="button"
          >
            Commit contributors
          </BusyActionButton>
        </div>
      ) : null}

      <Link className="button button--secondary" href={`/workspace/${workspaceId}/contributors`}>
        Back to contributors
      </Link>
    </section>
  );
}
