import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { listWorkspaceNotifications } from "@paylore/database";
import { NotificationCenter } from "../../../../components/workspace/NotificationCenter";
import {
  WorkspaceLegalFooter,
  WorkspaceNavigation
} from "../../../../components/workspace/WorkspaceNavigation";
import { getWorkspacePageContext } from "../../../../server/workspace-page-context";

export const metadata: Metadata = {
  title: "Notifications",
  robots: { index: false, follow: false }
};

export const dynamic = "force-dynamic";

export default async function WorkspaceNotificationsPage({
  params
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const context = await getWorkspacePageContext(
    workspaceId,
    `/workspace/${workspaceId}/notifications`
  );
  const notifications = await listWorkspaceNotifications(context.db, {
    workspaceId,
    recipientKey: context.session.userId,
    limit: 100
  });
  return (
    <main className="protected-wrap workspace-page">
      <WorkspaceNavigation
        workspaceId={workspaceId}
        workspaceName={context.workspace.workspaceName}
        role={context.workspace.role}
      />
      <header className="protected-header">
        <p className="eyebrow">Workspace updates</p>
        <h2>Notification Center</h2>
        <p>Updates for your role in this workspace, with read status saved to your account.</p>
      </header>
      <NotificationCenter
        workspaceId={workspaceId}
        notifications={notifications.map((notification) => ({
          id: notification.id,
          workspaceId,
          workspaceName: context.workspace.workspaceName,
          category: notification.category,
          title: notification.title,
          body: notification.body,
          destination: notification.destination,
          readAt: notification.readAt?.toISOString() ?? null,
          createdAt: notification.createdAt.toISOString()
        }))}
      />
      <WorkspaceLegalFooter />
    </main>
  );
}
