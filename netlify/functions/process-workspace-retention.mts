import {
  archiveExpiredWorkspaceSubscriptions,
  cleanupEligibleContributorAssociations,
  createDatabase,
  createWorkspaceRetentionNotice,
  hasReachedInactivityThreshold,
  listDueWorkspaceRetentionNotifications,
  WORKSPACE_RETENTION_NOTICE_DAYS
} from "../../packages/database";
import { parseConfig } from "../../apps/web/src/server/config";

export const config = {
  schedule: "0 8 * * *"
};

const noticeCopy = {
  30: {
    title: "Workspace inactivity notice",
    body: "Your workspace has been inactive for 30 days."
  },
  90: {
    title: "Workspace inactivity notice",
    body: "Your workspace has been inactive for 90 days."
  },
  180: {
    title: "Workspace inactivity notice",
    body: "Your workspace has been inactive for 180 days."
  },
  270: {
    title: "Workspace inactivity notice",
    body: "Your workspace has been inactive for 270 days."
  },
  330: {
    title: "Workspace data retention notice",
    body: "Your workspace has been inactive for 330 days. Your workspace data may be eligible for deletion after 365 days if no qualifying obligations remain."
  }
} satisfies Record<
  (typeof WORKSPACE_RETENTION_NOTICE_DAYS)[number],
  { title: string; body: string }
>;

export default async function processWorkspaceRetention() {
  const appConfig = parseConfig(process.env);
  const { db, client } = createDatabase(appConfig.DATABASE_URL);
  const now = new Date();
  try {
    const archived = await archiveExpiredWorkspaceSubscriptions(db, now);
    const contributorCleanup = await cleanupEligibleContributorAssociations(
      db,
      now
    );
    const workspaces = await listDueWorkspaceRetentionNotifications(db, 500);
    let notificationsCreated = 0;
    let workspacesProcessed = 0;

    for (const workspace of workspaces) {
      for (const day of WORKSPACE_RETENTION_NOTICE_DAYS) {
        if (
          day <= workspace.lastNoticeDay ||
          !hasReachedInactivityThreshold(
            workspace.lastActivityAt,
            day,
            now
          )
        ) {
          continue;
        }
        const result = await createWorkspaceRetentionNotice(db, {
          workspaceId: workspace.workspaceId,
          lastActivityAt: workspace.lastActivityAt,
          day,
          title: noticeCopy[day].title,
          body: noticeCopy[day].body,
          destination: `/workspace/${workspace.workspaceId}/settings/deletion`,
          now
        });
        notificationsCreated += result.created;
      }
      workspacesProcessed += 1;
    }

    console.log(JSON.stringify({
      event: "workspace_retention_processing_completed",
      archivedSubscriptions: archived,
      contributorAssociationsRemoved: contributorCleanup.removed,
      contributorAssociationsDeferred: contributorCleanup.deferred,
      workspacesProcessed,
      notificationsCreated
    }));
  } finally {
    await client.end({ timeout: 5 });
  }
}
