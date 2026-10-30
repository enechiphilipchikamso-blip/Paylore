import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  WorkspaceLegalFooter,
  WorkspaceNavigation
} from "../../../../../components/workspace/WorkspaceNavigation";
import { WorkspaceDeletionActions } from "../../../../../components/workspace/WorkspaceDeletionActions";
import { getWorkspacePageContext } from "../../../../../server/workspace-page-context";

export const metadata: Metadata = {
  title: "Workspace data retention",
  robots: { index: false, follow: false }
};

export const dynamic = "force-dynamic";

export default async function WorkspaceDeletionPage({
  params
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const context = await getWorkspacePageContext(
    workspaceId,
    `/workspace/${workspaceId}/settings/deletion`,
    { recordActivity: false }
  );
  if (context.workspace.role !== "organization_admin") notFound();

  return (
    <div className="protected-wrap workspace-page">
      <WorkspaceNavigation
        workspaceId={workspaceId}
        workspaceName={context.workspace.workspaceName}
        role={context.workspace.role}
        showRetentionBanner={false}
      />
      <header className="protected-header">
        <p className="eyebrow">Settings</p>
        <h2>Workspace data retention</h2>
        <p>
          Review the deletion waiting period and the safety checks that protect
          payroll obligations and funds.
        </p>
      </header>
      <WorkspaceDeletionActions workspaceId={workspaceId} />
      <WorkspaceLegalFooter />
    </div>
  );
}
