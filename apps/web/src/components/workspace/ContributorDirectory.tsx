"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";

type ContributorRecord = {
  id: string;
  displayName: string;
  identityWalletAddress: string;
  effectivePayoutAddress: string;
  organizationLabel: string | null;
  lifecycle: "invited" | "active" | "left";
  onboardingStatus: "pending" | "complete" | "incomplete";
  role: "organization_admin" | "finance_auditor" | "contributor";
};

const lifecycleLabels = {
  invited: "Invited",
  active: "Active",
  left: "Left"
} as const;

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
  const [notice, setNotice] = useState<{
    state: "success" | "error";
    text: string;
  } | null>(null);
  const filteredRecords = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return records;
    return records.filter((record) =>
      `${record.displayName} ${record.identityWalletAddress}`
        .toLowerCase()
        .includes(normalized)
    );
  }, [query, records]);

  async function updateLifecycle(
    record: ContributorRecord,
    lifecycle: ContributorRecord["lifecycle"]
  ) {
    setBusyId(record.id);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/contributors/${record.id}`,
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ lifecycle })
        }
      );
      if (!response.ok) {
        setNotice({
          state: "error",
          text: "Contributor record could not be updated. Please try again."
        });
        return;
      }
      setNotice({ state: "success", text: "Contributor record updated." });
      router.refresh();
    } catch {
      setNotice({
        state: "error",
        text: "Contributor record could not be updated. Please try again."
      });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="contributor-directory">
      <div className="workspace-dashboard__section-heading">
        <label className="field contributor-search">
          <span>Search contributors by name or wallet</span>
          <input
            onChange={(event) => setQuery(event.target.value)}
            type="search"
            value={query}
          />
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
            <Link className="button" href={`/workspace/${workspaceId}/contributors/import`}>
              Import contributors
            </Link>
          ) : null}
        </div>
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Status</th>
                <th scope="col">Identity wallet</th>
                <th scope="col">Payout address</th>
                <th scope="col">Onboarding</th>
                {canManage ? <th scope="col">Actions</th> : null}
              </tr>
            </thead>
            <tbody>
              {filteredRecords.map((record) => (
                <tr key={record.id}>
                  <td>
                    <strong>{record.displayName}</strong>
                    {record.organizationLabel ? <small>{record.organizationLabel}</small> : null}
                  </td>
                  <td>{lifecycleLabels[record.lifecycle]}</td>
                  <td><code>{record.identityWalletAddress}</code></td>
                  <td><code>{record.effectivePayoutAddress}</code></td>
                  <td>{record.onboardingStatus}</td>
                  {canManage ? (
                    <td>
                      <label className="visually-hidden" htmlFor={`lifecycle-${record.id}`}>
                        Update {record.displayName} lifecycle
                      </label>
                      <select
                        disabled={busyId === record.id}
                        id={`lifecycle-${record.id}`}
                        onChange={(event) =>
                          void updateLifecycle(
                            record,
                            event.target.value as ContributorRecord["lifecycle"]
                          )
                        }
                        value={record.lifecycle}
                      >
                        <option value="invited">Invited</option>
                        <option value="active">Active</option>
                        <option value="left">Left</option>
                      </select>
                      {busyId === record.id ? (
                        <span className="loading-indicator" role="status">
                          <span className="loading-indicator__icon" aria-hidden="true" />
                          Saving…
                        </span>
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
