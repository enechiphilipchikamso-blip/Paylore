import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  getWorkspaceReserve,
  getWorkspaceSubscription
} from "@paylore/database";
import {
  WorkspaceLegalFooter,
  WorkspaceNavigation
} from "../../../../../components/workspace/WorkspaceNavigation";
import { ReserveActions } from "../../../../../components/workspace/ReserveActions";
import { getWorkspacePageContext } from "../../../../../server/workspace-page-context";

export const metadata: Metadata = {
  title: "Confidential payroll reserve",
  robots: { index: false, follow: false }
};

export const dynamic = "force-dynamic";

export default async function WorkspaceReservePage({
  params
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const context = await getWorkspacePageContext(
    workspaceId,
    `/workspace/${workspaceId}/settings/reserve`
  );
  if (context.workspace.role !== "organization_admin") notFound();
  const [reserve, subscription] = await Promise.all([
    getWorkspaceReserve(context.db, workspaceId),
    getWorkspaceSubscription(context.db, workspaceId)
  ]);
  const canInitialize =
    subscription?.status === "active" ||
    subscription?.status === "cancel_scheduled";

  return (
    <main className="protected-wrap workspace-page">
      <WorkspaceNavigation
        workspaceId={workspaceId}
        workspaceName={context.workspace.workspaceName}
        role={context.workspace.role}
      />
      <header className="protected-header">
        <p className="eyebrow">Settings</p>
        <h2>Confidential payroll reserve</h2>
        <p>
          This workspace uses a dedicated confidential reserve for unclaimed
          payroll. Reserve private-key material is protected on the server and
          is never delivered to the browser.
        </p>
      </header>
      <section className="surface-card">
        {!canInitialize && !reserve ? (
          <div className="state-callout" data-state="partial">
            <span className="state-callout__signal" aria-hidden="true" />
            <p>Activate or renew the workspace before initializing its reserve.</p>
          </div>
        ) : null}
        <ReserveActions
          workspaceId={workspaceId}
          canInitialize={canInitialize}
          reserve={reserve
            ? {
                address: reserve.address,
                createdAt: reserve.createdAt.toISOString(),
                updatedAt: reserve.updatedAt.toISOString()
              }
            : null}
        />
      </section>
      <WorkspaceLegalFooter />
    </main>
  );
}
