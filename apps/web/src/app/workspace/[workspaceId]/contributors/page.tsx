import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { listWorkspaceContributors } from "@paylore/database";
import { ContributorDirectory } from "../../../../components/workspace/ContributorDirectory";
import {
  WorkspaceLegalFooter,
  WorkspaceNavigation
} from "../../../../components/workspace/WorkspaceNavigation";
import { getWorkspacePageContext } from "../../../../server/workspace-page-context";

export const metadata: Metadata = {
  title: "Contributors",
  robots: { index: false, follow: false }
};

export const dynamic = "force-dynamic";

export default async function ContributorsPage({
  params
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const context = await getWorkspacePageContext(
    workspaceId,
    `/workspace/${workspaceId}/contributors`
  );
  if (context.workspace.role === "contributor") notFound();
  const contributors = await listWorkspaceContributors(context.db, workspaceId);
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
        <h2>Contributors</h2>
        <p>
          {canManage
            ? "Manage workspace contributor records, onboarding, and invitation status."
            : "Review contributor roles, wallet associations and onboarding status. This Finance/Auditor view is read-only."}
        </p>
      </header>
      <section className="surface-card">
        <ContributorDirectory
          workspaceId={workspaceId}
          records={contributors.map((contributor) => ({
            id: contributor.id,
            displayName: contributor.displayName,
            identityWalletAddress: contributor.identityWalletAddress,
            effectivePayoutAddress: contributor.effectivePayoutAddress,
            organizationLabel: canManage ? contributor.organizationLabel : null,
            adminNote: canManage ? contributor.adminNote : null,
            lifecycle: contributor.lifecycle,
            onboardingStatus: contributor.onboardingStatus,
            role: contributor.role
          }))}
          canManage={canManage}
        />
      </section>
      <WorkspaceLegalFooter />
    </div>
  );
}
