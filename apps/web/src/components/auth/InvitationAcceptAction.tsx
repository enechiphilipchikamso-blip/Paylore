"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { BusyActionButton } from "../workspace/BusyActionButton";

export function InvitationAcceptAction({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [accepted, setAccepted] = useState(false);

  async function acceptInvitation() {
    if (busy || accepted) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/invitations/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        credentials: "same-origin"
      });
      if (!response.ok) {
        const failure = await response.json().catch(() => null) as { error?: string } | null;
        setMessage(
          failure?.error === "invitation_wallet_mismatch"
            ? "This invitation is not assigned to the authenticated wallet. Switch wallet and sign in with the invited wallet."
            : failure?.error === "authentication_required"
              ? "Your Paylore session ended. Sign in again with the invited wallet, then reopen this link."
              : response.status === 409
                ? "This invitation link is no longer open. It was already accepted, it expired, or the administrator issued a newer link that replaced it. Ask the administrator for the current link."
                : "The invitation could not be accepted. Please try again."
        );
        return;
      }
      const result = await response.json() as { workspacePath: string };
      setAccepted(true);
      router.replace(result.workspacePath);
      router.refresh();
    } catch {
      setMessage("The invitation could not be accepted. Check your connection and try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="invitation-accept-action">
      {accepted ? (
        <div className="state-callout" data-state="success" role="status">
          <span className="state-callout__signal" aria-hidden="true" />
          <p>Invitation accepted. Opening your workspace…</p>
        </div>
      ) : message ? (
        <div className="state-callout" data-state="error" role="alert">
          <span className="state-callout__signal" aria-hidden="true" />
          <p>{message}</p>
        </div>
      ) : null}
      <BusyActionButton className="button" busy={busy || accepted} onClick={() => void acceptInvitation()} type="button">
        {accepted ? "Opening workspace…" : busy ? "Accepting invitation…" : message ? "Retry accepting invitation" : "Accept invitation"}
      </BusyActionButton>
    </div>
  );
}
