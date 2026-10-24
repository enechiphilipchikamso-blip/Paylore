"use client";

import { Fragment, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";

type WorkspaceRole = "organization_admin" | "finance_auditor" | "contributor";
type ContributorRecord = {
  id: string;
  displayName: string;
  identityWalletAddress: string;
  effectivePayoutAddress: string;
  organizationLabel: string | null;
  adminNote: string | null;
  lifecycle: "invited" | "active" | "left";
  onboardingStatus: "pending" | "complete" | "incomplete";
  role: WorkspaceRole;
};
const lifecycleLabels = { invited: "Invited", active: "Active", left: "Left" } as const;
const roleLabels: Record<WorkspaceRole, string> = {
  organization_admin: "Organization Administrator",
  finance_auditor: "Finance/Auditor",
  contributor: "Contributor"
};

export function ContributorDirectory({
  workspaceId,
  records,
  canManage
}: {
  workspaceId: string;
  records: ContributorRecord[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [labelDraft, setLabelDraft] = useState("");
  const [noteDraft, setNoteDraft] = useState("");
  const [notice, setNotice] = useState<{ state: "success" | "error"; text: string } | null>(null);

  const filteredRecords = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return records;
    return records.filter((record) =>
      `${record.displayName} ${record.identityWalletAddress} ${roleLabels[record.role]} ${record.organizationLabel ?? ""}`
        .toLowerCase().includes(normalized)
    );
  }, [query, records]);

  function beginEdit(record: ContributorRecord) {
    setEditingId(record.id);
    setLabelDraft(record.organizationLabel ?? "");
    setNoteDraft(record.adminNote ?? "");
    setNotice(null);
  }

  async function saveProfile(record: ContributorRecord) {
    if (busyId !== null) return;
    setBusyId(record.id);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/contributors/${encodeURIComponent(record.id)}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ organizationLabel: labelDraft, adminNote: noteDraft })
        }
      );
      if (!response.ok) {
        setNotice({
          state: "error",
          text: response.status === 403
            ? "You are not authorized to edit contributor profile details."
            : response.status === 404
              ? "This contributor no longer belongs to the workspace. Refresh the directory."
              : "Contributor profile details could not be saved. Please try again."
        });
        return;
      }
      setEditingId(null);
      setNotice({ state: "success", text: "Contributor profile details saved." });
      router.refresh();
    } catch {
      setNotice({
        state: "error",
        text: "Contributor profile details could not be verified. Refresh before retrying."
      });
    } finally {
      setBusyId(null);
    }
  }

  async function requestOffboarding(record: ContributorRecord) {
    if (
      busyId !== null ||
      !window.confirm(
        `Request that ${record.displayName} review leaving this workspace? This does not remove membership or transfer ownership of the contributor's confidential account.`
      )
    ) return;
    setBusyId(record.id);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/workspaces/${encodeURIComponent(workspaceId)}/contributors/${encodeURIComponent(record.id)}/offboarding`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ confirmation: "Request contributor review" })
        }
      );
      if (!response.ok) {
        setNotice({
          state: "error",
          text: response.status === 403
            ? "You are not authorized to request this contributor action."
            : "The offboarding request could not be recorded. The contributor's access has not been changed."
        });
        return;
      }
      setNotice({
        state: "success",
        text: "Offboarding review requested. The contributor's workspace access remains active until they confirm departure."
      });
      router.refresh();
    } catch {
      setNotice({
        state: "error",
        text: "The offboarding request could not be verified. Refresh the contributor directory before retrying."
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="contributor-directory">
      <div className="workspace-dashboard__section-heading">
        <label className="field contributor-search">
          <span>Search contributors by name, wallet, or role</span>
          <input onChange={(event) => setQuery(event.target.value)} type="search" value={query} />
        </label>
        <div className="hero__actions">
          {canManage ? (
            <>
              <Link className="button button--secondary" href={`/workspace/${workspaceId}/contributors/import`}>
                Import contributors
              </Link>
              <Link className="button" href={`/workspace/${workspaceId}/contributors/invitations`}>
                Create invitation
              </Link>
            </>
          ) : null}
        </div>
      </div>

      {notice ? (
        <div className="state-callout" data-state={notice.state} role={notice.state === "error" ? "alert" : "status"}>
          <span className="state-callout__signal" aria-hidden="true" />
          <p>{notice.text}</p>
        </div>
      ) : null}

      {filteredRecords.length === 0 ? (
        <div className="workspace-empty-state">
          <h3>{records.length === 0 ? "No contributors have been added yet." : "No contributors match this search."}</h3>
          {records.length === 0 && canManage ? (
            <Link className="button" href={`/workspace/${workspaceId}/contributors/import`}>Import contributors</Link>
          ) : null}
        </div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Role</th>
                <th scope="col">Status</th>
                <th scope="col">Identity wallet</th>
                <th scope="col">Effective payout address</th>
                <th scope="col">Onboarding</th>
                {canManage ? <th scope="col">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {filteredRecords.map((record) => (
                <Fragment key={record.id}>
                  <tr>
                    <td>
                      <strong>{record.displayName}</strong>
                      {record.organizationLabel ? <small>{record.organizationLabel}</small> : null}
                      {canManage && record.adminNote ? <small>Admin note: {record.adminNote}</small> : null}
                    </td>
                    <td>{roleLabels[record.role]}</td>
                    <td>{lifecycleLabels[record.lifecycle]}</td>
                    <td><code>{record.identityWalletAddress}</code></td>
                    <td><code>{record.effectivePayoutAddress}</code></td>
                    <td>{record.onboardingStatus}</td>
                    {canManage ? (
                      <td>
                        <button className="button button--secondary" disabled={busyId !== null} onClick={() => beginEdit(record)} type="button">
                          Edit profile details
                        </button>
                        {record.role === "contributor" && record.lifecycle === "active" ? (
                          <button className="button button--secondary" disabled={busyId !== null} onClick={() => void requestOffboarding(record)} type="button">
                            Request offboarding review
                          </button>
                        ) : null}
                      </td>
                    ) : null}
                  </tr>
                  {canManage && editingId === record.id ? (
                    <tr>
                      <td colSpan={7}>
                        <form
                          className="contributor-profile-editor"
                          onSubmit={(event) => {
                            event.preventDefault();
                            void saveProfile(record);
                          }}
                        >
                          <h3>Edit {record.displayName}</h3>
                          <label className="field" htmlFor={`organization-label-${record.id}`}>
                            <span>Organization label</span>
                            <input id={`organization-label-${record.id}`} maxLength={120} onChange={(event) => setLabelDraft(event.target.value)} value={labelDraft} />
                          </label>
                          <label className="field" htmlFor={`admin-note-${record.id}`}>
                            <span>Administrator note</span>
                            <textarea id={`admin-note-${record.id}`} maxLength={2000} onChange={(event) => setNoteDraft(event.target.value)} rows={3} value={noteDraft} />
                          </label>
                          <div className="hero__actions">
                            <button className="button" disabled={busyId !== null} type="submit">{busyId === record.id ? "Saving…" : "Save profile details"}</button>
                            <button className="button button--secondary" disabled={busyId !== null} onClick={() => setEditingId(null)} type="button">Cancel</button>
                          </div>
                        </form>
                      </td>
                    </tr>
                  ) : null}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
