import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  findWorkspaceContributorByWallet,
  getContributorConfidentialAccount,
  getContributorOffboardingStatus,
  hasOpenContributorPayrollAllocations,
  listContributorPayrollAllocations
} from "@paylore/database";
import { ContributorCompensation } from "../../../../components/workspace/ContributorCompensation";
import {
  WorkspaceLegalFooter,
  WorkspaceNavigation
} from "../../../../components/workspace/WorkspaceNavigation";
import { loadPayloreConfig } from "../../../../server/config";
import { getWorkspacePageContext } from "../../../../server/workspace-page-context";

export const metadata: Metadata = {
  title: "Your compensation",
  robots: { index: false, follow: false }
};

export const dynamic = "force-dynamic";

export default async function ContributorCompensationPage({
  params
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const context = await getWorkspacePageContext(
    workspaceId,
    `/workspace/${workspaceId}/compensation`
  );
  if (context.workspace.role !== "contributor") notFound();
  const contributor = await findWorkspaceContributorByWallet(
    context.db,
    workspaceId,
    context.session.walletAddress
  );
  if (!contributor || contributor.lifecycle === "left") notFound();
  const [account, hasOpenAllocations, offboarding, allocations] = await Promise.all([
    getContributorConfidentialAccount(
      context.db,
      workspaceId,
      contributor.id
    ),
    hasOpenContributorPayrollAllocations(
      context.db,
      workspaceId,
      contributor.id
    ),
    getContributorOffboardingStatus(
      context.db,
      workspaceId,
      contributor.id
    ),
    listContributorPayrollAllocations(
      context.db,
      workspaceId,
      contributor.id
    )
  ]);
  const config = loadPayloreConfig();
  return (
    <main className="protected-wrap workspace-page">
      <WorkspaceNavigation
        workspaceId={workspaceId}
        workspaceName={context.workspace.workspaceName}
        role={context.workspace.role}
      />
      <header className="protected-header">
        <p className="eyebrow">Contributor workspace</p>
        <h2>Your compensation</h2>
        <p>Manage your confidential account and review compensation assigned to your wallet.</p>
      </header>
      <ContributorCompensation
        workspaceId={workspaceId}
        walletAddress={context.session.walletAddress}
        mint={config.PAYLORE_WRAPPED_USDC_MINT ?? null}
        circleMint={config.PAYLORE_SUBSCRIPTION_USDC_MINT ?? null}
        tokenWrapProgramId={config.TOKEN_WRAP_PROGRAM_ID}
        tokenWrapUnwrapEnabled={config.TOKEN_WRAP_UNWRAP_ENABLED}
        account={account ? {
          ownerWalletAddress: account.ownerWalletAddress,
          tokenAccountAddress: account.tokenAccountAddress,
          status: account.status,
          setupTransactionSignature: account.setupTransactionSignature,
          closeTransactionSignature: account.closeTransactionSignature
        } : null}
        allocations={allocations.map((allocation) => ({
          id: allocation.id,
          runId: allocation.runId,
          runCreatedAt: allocation.runCreatedAt.toISOString(),
          amountBaseUnits: allocation.amountBaseUnits,
          status: allocation.status,
          claimAddress: allocation.claimAddress,
          transactionSignature: allocation.transactionSignature,
          claimedAt: allocation.claimedAt?.toISOString() ?? null,
          recoveredAt: allocation.recoveredAt?.toISOString() ?? null,
          settlementSignature: allocation.settlementSignature
        }))}
        hasOpenAllocations={hasOpenAllocations}
        offboardingRequested={offboarding?.status === "requested"}
      />
      <WorkspaceLegalFooter />
    </main>
  );
}
