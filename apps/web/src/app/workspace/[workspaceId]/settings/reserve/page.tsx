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
          This workspace has a dedicated reserve signing address. Its private
          key is protected on the server and never delivered to the browser.
          Key custody alone does not create or fund an on-chain confidential
          reserve. Configure the reserve-owned Token-2022 account and matching
          Payroll Program reserve state, then fund it with the configured
          wrapped-USDC mint. A payroll claim is reported settled only after its
          confidential transfer reaches finality and the reserve debit is
          reconciled.
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
