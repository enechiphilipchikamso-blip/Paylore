import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  listWorkspaceContributors,
  listWorkspaceInvitations
} from "@paylore/database";
import { InvitationManager } from "../../../../../components/workspace/InvitationManager";
import {
  WorkspaceLegalFooter,
  WorkspaceNavigation
} from "../../../../../components/workspace/WorkspaceNavigation";
import { getWorkspacePageContext } from "../../../../../server/workspace-page-context";

export const metadata: Metadata = {
  title: "Contributor invitations",
  robots: { index: false, follow: false }
};

export const dynamic = "force-dynamic";

export default async function ContributorInvitationsPage({
  params
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const context = await getWorkspacePageContext(
    workspaceId,
    `/workspace/${workspaceId}/contributors/invitations`
  );
  if (context.workspace.role !== "organization_admin") notFound();
  const [contributors, invitations] = await Promise.all([
    listWorkspaceContributors(context.db, workspaceId),
    listWorkspaceInvitations(context.db, workspaceId)
  ]);
  const canManage = context.workspace.role === "organization_admin";

  return (
    <div className="protected-wrap workspace-page">
      <WorkspaceNavigation
        workspaceId={workspaceId}
        workspaceName={context.workspace.workspaceName}
        role={context.workspace.role}
      />
      <header className="protected-header">
        <p className="eyebrow">Workspace</p>
        <h2>Contributor invitations</h2>
        <p>
          Create a separate invitation for each contributor. Each link is
          bound to that contributor and can only be accepted after
          authentication with the contributor&apos;s assigned wallet.
        </p>
      </header>
      <InvitationManager
        workspaceId={workspaceId}
        contributors={contributors
          .filter((contributor) => contributor.lifecycle !== "left" && contributor.role !== "organization_admin")
          .map(({ id, displayName, role }) => ({ id, displayName, role }))}
        invitations={invitations.map((invitation) => ({
          id: invitation.id,
          contributorName: invitation.contributorName,
          contributorRole: invitation.contributorRole,
          acceptedAt: invitation.acceptedAt?.toISOString() ?? null,
          expiresAt: invitation.expiresAt.toISOString()
        }))}
        canManage={canManage}
      />
      <WorkspaceLegalFooter />
    </div>
  );
}
