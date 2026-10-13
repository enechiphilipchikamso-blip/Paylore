import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  getWorkspaceGasTank,
  listWorkspaceLedgerEntries
} from "@paylore/database";
import {
  WorkspaceLegalFooter,
  WorkspaceNavigation
} from "../../../../components/workspace/WorkspaceNavigation";
import { GasTankActions } from "../../../../components/workspace/GasTankActions";
import { getWorkspacePageContext } from "../../../../server/workspace-page-context";
import { getWorkspaceGasTankSnapshot } from "../../../../server/gas-tank";

export const metadata: Metadata = {
  title: "Gas Tank",
  robots: { index: false, follow: false }
};

export const dynamic = "force-dynamic";

export default async function WorkspaceGasTankPage({
  params
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const context = await getWorkspacePageContext(
    workspaceId,
    `/workspace/${workspaceId}/gas-tank`
  );
  if (context.workspace.role === "contributor") notFound();

  let gasTank: {
    address: string;
    balanceLamports: string | null;
    lowBalance: boolean;
    balanceUnavailable: boolean;
    lastActivityAt: string | null;
    updatedAt: string;
  } | null = null;
  try {
    const snapshot = await getWorkspaceGasTankSnapshot(
      context.db,
      workspaceId
    );
    gasTank = snapshot
      ? {
          address: snapshot.address,
          balanceLamports: snapshot.balanceLamports,
          lowBalance: snapshot.lowBalance,
          balanceUnavailable: false,
          lastActivityAt: snapshot.lastActivityAt?.toISOString() ?? null,
          updatedAt: snapshot.updatedAt.toISOString()
        }
      : null;
  } catch {
    console.error(JSON.stringify({ event: "gas_tank_page_balance_unavailable" }));
    const stored = await getWorkspaceGasTank(context.db, workspaceId);
    if (stored) {
      gasTank = {
        address: stored.address,
        balanceLamports: null,
        lowBalance: false,
        balanceUnavailable: true,
        lastActivityAt: stored.lastActivityAt?.toISOString() ?? null,
        updatedAt: stored.updatedAt.toISOString()
      };
    }
  }

  const entries = await listWorkspaceLedgerEntries(context.db, {
    workspaceId,
    category: "gas_operations",
    limit: 20
  });
  const latestFunding = entries.find(
    (entry) => entry.entryType === "gas_tank_funding" &&
      entry.status === "finalized" &&
      entry.transactionSignature
  );

  return (
    <main className="protected-wrap workspace-page">
      <WorkspaceNavigation
        workspaceId={workspaceId}
        workspaceName={context.workspace.workspaceName}
        role={context.workspace.role}
      />
      <header className="protected-header">
        <p className="eyebrow">Gas Tank</p>
        <h2>Gas Tank</h2>
        <p>
          Manage the network fees Paylore can sponsor for approved workspace
          operations. Funding is manual. Paylore does not automatically refill
          this balance.
        </p>
      </header>
      {gasTank?.balanceUnavailable ? (
        <div className="state-callout" data-state="partial" role="status">
          <span className="state-callout__signal" aria-hidden="true" />
          <p>The live network-fee balance is unavailable. The stored balance is not being shown as current.</p>
        </div>
      ) : null}
      <section className="surface-card">
        <GasTankActions
          workspaceId={workspaceId}
          walletAddress={context.session.walletAddress}
          gasTank={gasTank}
          canManage={context.workspace.role === "organization_admin"}
          latestFunding={latestFunding
            ? {
                signature: latestFunding.transactionSignature!,
                amountLamports: latestFunding.amountBaseUnits,
                createdAt: latestFunding.createdAt.toISOString()
              }
            : null}
        />
      </section>
      <WorkspaceLegalFooter />
    </main>
  );
}
