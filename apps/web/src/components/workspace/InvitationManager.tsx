"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState } from "react";
import { BusyActionButton } from "./BusyActionButton";

type ContributorOption = { id: string; displayName: string; role: "organization_admin" | "finance_auditor" | "contributor" };
type InvitationView = {
  id: string;
  contributorId: string;
  contributorName: string;
  contributorRole: "organization_admin" | "finance_auditor" | "contributor";
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
  const router = useRouter();
  const [contributorId, setContributorId] = useState(contributors[0]?.id ?? "");
  const [invitePath, setInvitePath] = useState<string | null>(null);
  const [inviteeName, setInviteeName] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copyBusy, setCopyBusy] = useState(false);
  const [notice, setNotice] = useState<{
    state: "success" | "error" | "partial";
    text: string;
  } | null>(null);

  /** One row per contributor: an accepted invitation wins; otherwise the newest open link. */
  const groups = useMemo(() => {
    const byContributor = new Map<string, InvitationView[]>();
    for (const invitation of invitations) {
      const list = byContributor.get(invitation.contributorId) ?? [];
      list.push(invitation);
      byContributor.set(invitation.contributorId, list);
    }
    return [...byContributor.values()].map((list) => {
      const accepted = list.find((invitation) => invitation.acceptedAt);
      const pending = list.filter((invitation) => !invitation.acceptedAt);
      const current = accepted ?? pending[0]!;
      return {
        contributorId: current.contributorId,
        contributorName: current.contributorName,
        contributorRole: current.contributorRole,
        accepted: Boolean(accepted),
        acceptedAt: accepted?.acceptedAt ?? null,
        expiresAt: current.expiresAt,
        redundantLinks: accepted ? pending.length : Math.max(0, pending.length - 1)
      };
    }).sort((left, right) => Number(left.accepted) - Number(right.accepted) ||
      left.contributorName.localeCompare(right.contributorName));
  }, [invitations]);
  const joinedContributorIds = new Set(
    groups.filter((group) => group.accepted).map((group) => group.contributorId)
  );
  const pendingContributorIds = new Set(
    groups.filter((group) => !group.accepted).map((group) => group.contributorId)
  );
  const selectedJoined = joinedContributorIds.has(contributorId);
  const selectedPending = pendingContributorIds.has(contributorId);

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
        const failure = await response.json().catch(() => null) as { error?: string } | null;
        setNotice({
          state: "error",
          text: failure?.error === "contributor_already_joined"
            ? `${invitee.displayName} has already accepted an invitation and is a workspace member. No new link was created.`
            : failure?.error === "contributor_not_eligible_for_invitation"
              ? `${invitee.displayName} is not eligible for an invitation (they left the workspace or are an administrator).`
              : failure?.error === "workspace_read_only"
                ? "The workspace subscription is not active. Renew the workspace before creating invitations."
                : "The invitation could not be prepared. Please try again."
        });
        return;
      }
      const body = await response.json() as { invitePath: string; supersededCount?: number };
      setInvitePath(body.invitePath);
      setInviteeName(invitee.displayName);
      setNotice({
        state: "success",
        text: (body.supersededCount ?? 0) > 0
          ? `Invitation link created. ${body.supersededCount} earlier link(s) for ${invitee.displayName} were closed, so only this link can be used. Copy it now; it is shown only in this session.`
          : "Invitation link created. Copy it now; the link is shown only in this session."
      });
      router.refresh();
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
    if (!invitePath || copyBusy) return;
    setCopyBusy(true);
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${invitePath}`);
      setNotice({ state: "success", text: "Invitation copied." });
    } catch {
      setNotice({
        state: "error",
        text: "The invitation could not be copied. Please copy the link shown below."
      });
    } finally {
      setCopyBusy(false);
    }
  }

  return (
    <div className="invitation-manager reserve-actions">
      {canManage ? (
        <section className="reserve-panel" aria-labelledby="invitation-create-heading">
          <header className="reserve-panel__header">
            <h3 id="invitation-create-heading">Create invitation</h3>
            <p>
              Each contributor has at most one open invitation link. Creating a
              new link closes any earlier open link for the same contributor,
              and accepting a link closes the rest automatically.
            </p>
          </header>
          {contributors.length === 0 ? (
            <div className="workspace-empty-state">
              <p>Add a contributor before creating an invitation.</p>
            </div>
          ) : (
            <>
              <label className="field reserve-funding__field">
                <span>Contributor</span>
                <select
                  disabled={busy}
                  onChange={(event) => setContributorId(event.target.value)}
                  value={contributorId}
                >
                  {contributors.map((contributor) => (
                    <option key={contributor.id} value={contributor.id}>
                      {contributor.displayName} — {roleLabel(contributor.role)}
                      {joinedContributorIds.has(contributor.id)
                        ? " (joined)"
                        : pendingContributorIds.has(contributor.id)
                          ? " (invitation pending)"
                          : ""}
                    </option>
                  ))}
                </select>
              </label>
              {selectedJoined ? (
                <p className="field__helper">This contributor has already joined the workspace. A new invitation is not needed.</p>
              ) : selectedPending ? (
                <p className="field__helper">An invitation link is already open for this contributor. Creating a new one replaces it; the earlier link stops working.</p>
              ) : null}
              <div className="reserve-panel__actions reserve-panel__actions--footer">
                <BusyActionButton
                  className="button"
                  busy={busy}
                  disabled={!contributorId || selectedJoined}
                  onClick={() => void createInvitation()}
                  type="button"
                >
                  {busy
                    ? "Creating invitation…"
                    : selectedPending
                      ? "Replace invitation link"
                      : "Create invitation"}
                </BusyActionButton>
              </div>
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
        <section className="reserve-panel" aria-labelledby="invitation-link-heading">
          <header className="reserve-panel__header">
            <h3 id="invitation-link-heading">Invitation link for {inviteeName ?? "the selected contributor"}</h3>
          </header>
          <label className="field">
            <span>Link</span>
            <input readOnly value={invitePath} onFocus={(event) => event.currentTarget.select()} />
          </label>
          <div className="reserve-panel__actions">
            <BusyActionButton className="button button--secondary" busy={copyBusy} onClick={() => void copyInvitation()} type="button">
              {copyBusy ? "Copying…" : "Copy invitation link"}
            </BusyActionButton>
          </div>
        </section>
      ) : null}

      <section className="reserve-panel" aria-labelledby="invitation-status-heading">
        <header className="reserve-panel__header">
          <h3 id="invitation-status-heading">Invitation status</h3>
          <p>
            The invited wallet must match the contributor identity associated
            with the invitation and must complete Paylore authentication.
          </p>
        </header>
        {groups.length === 0 ? (
          <p>No active invitation is available for this workspace.</p>
        ) : (
          <ul className="invitation-groups">
            {groups.map((group) => (
              <li className="invitation-group" key={group.contributorId}>
                <div className="invitation-group__header">
                  <div className="invitation-group__who">
                    <strong>{group.contributorName}</strong>
                    <span className="invitation-group__meta">{roleLabel(group.contributorRole)}</span>
                  </div>
                  <span className="payroll-status" data-tone={group.accepted ? "success" : "partial"}>
                    {group.accepted ? "Joined" : "Pending"}
                  </span>
                  <span className="invitation-group__meta">
                    {group.accepted && group.acceptedAt ? (
                      <>Accepted <time dateTime={group.acceptedAt}>{new Date(group.acceptedAt).toLocaleDateString()}</time></>
                    ) : (
                      <>Expires <time dateTime={group.expiresAt}>{new Date(group.expiresAt).toLocaleDateString()}</time></>
                    )}
                  </span>
                </div>
                {group.redundantLinks > 0 ? (
                  <p className="invitation-group__meta">
                    {group.accepted
                      ? `${group.redundantLinks} older unused link(s) were issued before this contributor joined. They grant no additional access; the contributor is already a member.`
                      : `${group.redundantLinks} older link(s) are still open from before duplicate protection. Select this contributor and replace the link to close them.`}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function roleLabel(role: ContributorOption["role"]) {
  return role === "finance_auditor"
    ? "Finance/Auditor"
    : role === "organization_admin"
      ? "Organization Administrator"
      : "Contributor";
}
