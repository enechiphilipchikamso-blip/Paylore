"use client";

import { useState } from "react";

type ContributorOption = { id: string; displayName: string };
type InvitationView = {
  id: string;
  contributorName: string;
  acceptedAt: string | null;
  expiresAt: string;
};

export function InvitationManager({
  workspaceId,
  contributors,
  invitations,
  canManage
}: {
  workspaceId: string;
  contributors: ContributorOption[];
  invitations: InvitationView[];
  canManage: boolean;
}) {
  const [contributorId, setContributorId] = useState(contributors[0]?.id ?? "");
  const [invitePath, setInvitePath] = useState<string | null>(null);
  const [inviteeName, setInviteeName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{
    state: "success" | "error";
    text: string;
  } | null>(null);

  async function createInvitation() {
    const invitee = contributors.find(
      (contributor) => contributor.id === contributorId
    );
    if (!invitee) {
      setNotice({
        state: "error",
        text: "Select an eligible contributor before creating an invitation."
      });
      return;
    }

    setBusy(true);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/contributors/invitations`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ contributorId })
        }
      );
      if (!response.ok) {
        setNotice({
          state: "error",
          text: "The invitation could not be prepared. Please try again."
        });
        return;
      }
      const body = await response.json() as { invitePath: string };
      setInvitePath(body.invitePath);
      setInviteeName(invitee.displayName);
      setNotice({
        state: "success",
        text: "Invitation link created. Copy it now; the link is shown only in this session."
      });
    } catch {
      setNotice({
        state: "error",
        text: "The invitation could not be prepared. Please try again."
      });
    } finally {
      setBusy(false);
    }
  }

  async function copyInvitation() {
    if (!invitePath) return;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${invitePath}`);
      setNotice({ state: "success", text: "Invitation copied." });
    } catch {
      setNotice({
        state: "error",
        text: "The invitation could not be copied. Please copy the link shown below."
      });
    }
  }

  return (
    <div className="invitation-manager">
      {canManage ? (
        <section className="invite-state">
          <h2>Create invitation</h2>
          {contributors.length === 0 ? (
            <div className="workspace-empty-state">
              <p>Add a contributor before creating an invitation.</p>
            </div>
          ) : (
            <>
              <label className="field">
                <span>Contributor</span>
                <select
                  onChange={(event) => setContributorId(event.target.value)}
                  value={contributorId}
                >
                  {contributors.map((contributor) => (
                    <option key={contributor.id} value={contributor.id}>
                      {contributor.displayName}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="button"
                disabled={busy || !contributorId}
                onClick={() => void createInvitation()}
                type="button"
              >
                {busy ? "Saving…" : "Create invitation"}
              </button>
            </>
          )}
        </section>
      ) : null}

      {notice ? (
        <div className="state-callout" data-state={notice.state} role={notice.state === "error" ? "alert" : "status"}>
          <span className="state-callout__signal" aria-hidden="true" />
          <p>{notice.text}</p>
        </div>
      ) : null}

      {invitePath ? (
        <div className="invite-link">
          <label className="field">
            <span>
              Invitation link for {inviteeName ?? "the selected contributor"}
            </span>
            <input readOnly value={invitePath} />
          </label>
          <button className="button button--secondary" onClick={() => void copyInvitation()} type="button">
            Copy invitation link
          </button>
        </div>
      ) : null}

      <section className="surface-card">
        <h2>Invitation status</h2>
        {invitations.length === 0 ? (
          <p>No active invitation is available for this workspace.</p>
        ) : (
          <ul className="invitation-list">
            {invitations.map((invitation) => (
              <li key={invitation.id}>
                <strong>{invitation.contributorName}</strong>
                <span>{invitation.acceptedAt ? "Accepted" : "Pending"}</span>
                <time dateTime={invitation.expiresAt}>
                  Expires {new Date(invitation.expiresAt).toLocaleDateString()}
                </time>
              </li>
            ))}
          </ul>
        )}
        <p>
          The invited wallet must match the contributor identity associated
          with this workspace invitation and must complete Paylore authentication.
        </p>
      </section>
    </div>
  );
}
