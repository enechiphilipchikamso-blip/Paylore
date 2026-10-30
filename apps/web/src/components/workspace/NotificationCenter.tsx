"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { BusyActionButton } from "./BusyActionButton";

type Notification = {
  id: string;
  workspaceId: string;
  workspaceName?: string | null;
  category: string;
  title: string;
  body: string;
  destination: string | null;
  readAt: string | null;
  createdAt: string;
};

export function NotificationCenter({
  workspaceId,
  notifications
}: {
  workspaceId: string | null;
  notifications: Notification[];
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{
    state: "success" | "error";
    text: string;
  } | null>(null);

  async function markRead(notificationId: string) {
    if (busyId) return;
    setBusyId(notificationId);
    setNotice(null);
    try {
      const response = await fetch(
        workspaceId
          ? `/api/workspaces/${workspaceId}/notifications`
          : "/api/notifications",
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "mark_read", notificationId })
        }
      );
      if (!response.ok) {
        setNotice({ state: "error", text: "The notification could not be marked as read. Refresh and try again." });
        return;
      }
      setNotice({ state: "success", text: "Notification marked as read." });
      router.refresh();
    } catch {
      setNotice({ state: "error", text: "The notification could not be updated. Check your connection and retry." });
    } finally {
      setBusyId(null);
    }
  }

  async function markAllRead() {
    if (busyId) return;
    setBusyId("all");
    setNotice(null);
    try {
      const response = await fetch(
        workspaceId
          ? `/api/workspaces/${workspaceId}/notifications`
          : "/api/notifications",
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "mark_all_read" })
        }
      );
      if (!response.ok) {
        setNotice({ state: "error", text: "Notifications could not be updated. Refresh and try again." });
        return;
      }
      setNotice({ state: "success", text: "All notifications marked as read." });
      router.refresh();
    } catch {
      setNotice({ state: "error", text: "Notifications could not be updated. Check your connection and retry." });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <section className="surface-card" aria-labelledby="notifications-title">
      <h2 id="notifications-title">Notifications</h2>
      {notifications.some((notification) => !notification.readAt) ? (
        <BusyActionButton
          busy={busyId === "all"}
          className="button button--secondary"
          disabled={busyId !== null && busyId !== "all"}
          onClick={() => void markAllRead()}
          type="button"
        >
          {busyId === "all" ? "Updating…" : "Mark all as read"}
        </BusyActionButton>
      ) : null}
      {notice ? (
        <div
          className="state-callout"
          data-state={notice.state}
          role={notice.state === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          <span className="state-callout__signal" aria-hidden="true" />
          <p>{notice.text}</p>
        </div>
      ) : null}
      {notifications.length === 0 ? (
        <div className="workspace-empty-state">
          <h3>No notifications yet</h3>
          <p>You&apos;re all caught up. New workspace notifications will appear here.</p>
        </div>
      ) : (
        <ul className="notification-list">
          {notifications.map((notification) => (
            <li
              className="notification-list__item"
              data-read={notification.readAt ? "true" : "false"}
              key={notification.id}
            >
              <article>
                <p className="eyebrow">
                  {notification.category}
                  {notification.readAt ? "" : " · Unread"}
                </p>
                {!workspaceId && notification.workspaceName ? (
                  <p className="eyebrow">{notification.workspaceName}</p>
                ) : null}
                <h3>{notification.title}</h3>
                <p>{notification.body}</p>
                <time dateTime={notification.createdAt}>
                  {new Date(notification.createdAt).toLocaleString()}
                </time>
                {notification.destination &&
                (workspaceId
                  ? notification.destination.startsWith(
                      `/workspace/${workspaceId}/`
                    )
                  : notification.destination.startsWith("/") &&
                    !notification.destination.startsWith("//")) ? (
                  <p>
                    <Link href={notification.destination}>Open related page</Link>
                  </p>
                ) : null}
                {!notification.readAt ? (
                  <BusyActionButton
                    busy={busyId === notification.id}
                    className="button button--secondary"
                    disabled={busyId !== null && busyId !== notification.id}
                    onClick={() => void markRead(notification.id)}
                    type="button"
                  >
                    {busyId === notification.id ? "Updating…" : "Mark as read"}
                  </BusyActionButton>
                ) : null}
              </article>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
