"use client";

import Link from "next/link";
import { useEffect, useState } from "react";

type RetentionNotification = {
  id: string;
  title: string;
  body: string;
  destination: string | null;
};

export function WorkspaceRetentionBanner({
  workspaceId
}: {
  workspaceId: string;
}) {
  const [notification, setNotification] =
    useState<RetentionNotification | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    const query = new URLSearchParams({
      category: "Data Retention & Deletion",
      unreadOnly: "true"
    });
    void fetch(
      `/api/workspaces/${workspaceId}/notifications?${query.toString()}`,
      { cache: "no-store" }
    )
      .then(async (response) => {
        const result = await response.json().catch(() => null);
        if (!response.ok || !Array.isArray(result?.notifications)) {
          throw new Error("Retention notifications could not be loaded.");
        }
        if (active && result.notifications[0]) {
          setNotification(result.notifications[0] as RetentionNotification);
        }
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [workspaceId]);

  async function acknowledge() {
    if (!notification) return;
    setBusy(true);
    setError(false);
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/notifications`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            action: "mark_read",
            notificationId: notification.id
          })
        }
      );
      if (!response.ok) {
        throw new Error("The retention notice could not be acknowledged.");
      }
      setNotification(null);
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  if (!notification && !error) return null;
  return (
    <aside
      className="state-callout"
      data-state={error ? "error" : "partial"}
      role={error ? "alert" : "status"}
      aria-live="polite"
    >
      <span className="state-callout__signal" aria-hidden="true" />
      {notification ? (
        <>
          <strong>{notification.title}</strong>
          <p>{notification.body}</p>
          <div className="form-actions">
            {notification.destination ? (
              <Link href={notification.destination}>Review retention</Link>
            ) : null}
            <button
              type="button"
              className="button-secondary"
              disabled={busy}
              onClick={() => void acknowledge()}
            >
              {busy ? "Updating…" : "Acknowledge"}
            </button>
          </div>
        </>
      ) : (
        <p>
          Retention notices could not be loaded. Review{" "}
          <Link href={`/workspace/${workspaceId}/notifications`}>
            Notifications
          </Link>
          .
        </p>
      )}
    </aside>
  );
}
