import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getWorkspaceSubscription } from "@paylore/database";
import { ContributorImportForm } from "../../../../../components/workspace/ContributorImportForm";
import {
  WorkspaceLegalFooter,
  WorkspaceNavigation
} from "../../../../../components/workspace/WorkspaceNavigation";
import { getWorkspacePageContext } from "../../../../../server/workspace-page-context";

export const metadata: Metadata = {
  title: "Import contributors",
  robots: { index: false, follow: false }
};

export const dynamic = "force-dynamic";

export default async function ContributorImportPage({
  params
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const context = await getWorkspacePageContext(
    workspaceId,
    `/workspace/${workspaceId}/contributors/import`
  );
  if (context.workspace.role !== "organization_admin") notFound();
  const subscription = await getWorkspaceSubscription(context.db, workspaceId);
  const editable =
    subscription?.status === "active" ||
    subscription?.status === "cancel_scheduled";

  return (
    <div className="protected-wrap workspace-page">
      <WorkspaceNavigation
        workspaceId={workspaceId}
        workspaceName={context.workspace.workspaceName}
        role={context.workspace.role}
      />
      <header className="protected-header">
        <p className="eyebrow">Workspace</p>
        <h2>Import contributors</h2>
      </header>
      {editable ? (
        <ContributorImportForm workspaceId={workspaceId} />
      ) : (
        <section className="surface-card">
          <div className="state-callout" data-state="partial">
            <span className="state-callout__signal" aria-hidden="true" />
            <p>This workspace is in Read-Only Archive Mode. Renew the workspace before adding contributors.</p>
          </div>
          <Link className="button" href={`/workspace/${workspaceId}/billing`}>Manage billing</Link>
        </section>
      )}
      <WorkspaceLegalFooter />
    </div>
  );
}
