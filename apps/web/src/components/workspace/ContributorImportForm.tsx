"use client";

import Link from "next/link";
import { useState } from "react";
import type { ContributorImportResult } from "../../server/contributors-parser";

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
        setPreview(null);
        setNotice({
          state: "error",
          text: response.status === 413
            ? "The file could not be processed. Please correct the errors and upload again."
            : "The file could not be processed. Please correct the errors and upload again."
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
    } catch {
      setPreview(null);
      setNotice({
        state: "error",
        text: "The file could not be processed. Please correct the errors and upload again."
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
        setNotice({
          state: "error",
          text: "Contributors could not be saved. Please review the file and try again."
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
    } catch {
      setNotice({
        state: "error",
        text: "Something went wrong. Please try again."
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
      <button className="button" disabled={!file || busy} onClick={() => void createPreview()} type="button">
        {busy ? "Preparing preview…" : "Preview import"}
      </button>

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
          <button className="button" disabled={preview.validCount === 0 || busy} onClick={() => void commit()} type="button">
            Commit contributors
          </button>
        </div>
      ) : null}

      <Link className="button button--secondary" href={`/workspace/${workspaceId}/contributors`}>
        Back to contributors
      </Link>
    </section>
  );
}
