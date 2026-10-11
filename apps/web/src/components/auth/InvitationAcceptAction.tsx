"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function InvitationAcceptAction({ token }: { token: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function acceptInvitation() {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/invitations/${encodeURIComponent(token)}/accept`, {
        method: "POST",
        credentials: "same-origin"
      });
      if (!response.ok) {
        setMessage(
          response.status === 403
            ? "This invitation is not assigned to the authenticated wallet."
            : response.status === 409
              ? "This invitation is no longer available."
              : "The invitation could not be accepted. Please try again."
        );
        return;
      }
      const result = await response.json() as { workspacePath: string };
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
      {message ? (
        <div className="state-callout" data-state="error" role="alert">
          <span className="state-callout__signal" aria-hidden="true" />
          <p>{message}</p>
        </div>
      ) : null}
      <button className="button" disabled={busy} onClick={() => void acceptInvitation()} type="button">
        {busy ? "Accepting invitation…" : "Accept invitation"}
      </button>
    </div>
  );
}
