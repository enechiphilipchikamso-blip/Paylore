import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import { listUserNotifications } from "@paylore/database";
import { NotificationCenter } from "../../components/workspace/NotificationCenter";
import { getDatabase } from "../../server/db";
import { getSessionState } from "../../server/session";

export const metadata: Metadata = {
  title: "Notifications",
  robots: { index: false, follow: false }
};

export const dynamic = "force-dynamic";

export default async function NotificationsPage() {
  const session = await getSessionState();
  if (session.status !== "authenticated") {
    redirect("/auth?next=%2Fnotifications");
  }
  const notifications = await listUserNotifications(
    getDatabase(),
    session.session.userId
  );
  return (
    <main className="protected-wrap workspace-page">
      <header className="protected-header">
        <p className="eyebrow">Your account</p>
        <h1>Notification Center</h1>
        <p>Notifications across your current and former workspace associations.</p>
        <Link className="button button--secondary" href="/">
          Return to Paylore
        </Link>
      </header>
      <NotificationCenter
        workspaceId={null}
        notifications={notifications.map((notification) => ({
          id: notification.id,
          workspaceId: notification.workspaceId,
          workspaceName: notification.workspaceName,
          category: notification.category,
          title: notification.title,
          body: notification.body,
          destination: notification.destination,
          readAt: notification.readAt?.toISOString() ?? null,
          createdAt: notification.createdAt.toISOString()
        }))}
      />
    </main>
  );
}
