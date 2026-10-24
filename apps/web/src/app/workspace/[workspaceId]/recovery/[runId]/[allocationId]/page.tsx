import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getWorkspacePayrollRun } from "@paylore/database";
import { PayrollRecoveryAction } from "../../../../../../components/workspace/PayrollRecoveryAction";
import {
  WorkspaceLegalFooter,
  WorkspaceNavigation
} from "../../../../../../components/workspace/WorkspaceNavigation";
import { loadPayloreConfig } from "../../../../../../server/config";
import { getWorkspacePageContext } from "../../../../../../server/workspace-page-context";

export const metadata: Metadata = {
  title: "Payroll recovery detail",
  robots: { index: false, follow: false }
};

export const dynamic = "force-dynamic";

function formatUsdc(baseUnits: string): string {
  const amount = BigInt(baseUnits);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function stateLabel(status: string): string {
  switch (status) {
    case "unclaimed": return "Unclaimed";
    case "settlement_pending": return "Settlement pending";
    case "claimed": return "Claimed";
    case "recovered": return "Recovered";
    case "cancelled": return "Cancelled";
    default: return "Status requires review";
  }
}

export default async function WorkspaceRecoveryDetailPage({
  params
}: {
  params: Promise<{ workspaceId: string; runId: string; allocationId: string }>;
}) {
  const { workspaceId, runId, allocationId } = await params;
  const context = await getWorkspacePageContext(
    workspaceId,
    `/workspace/${workspaceId}/recovery/${runId}/${allocationId}`
  );
  if (context.workspace.role !== "organization_admin") notFound();

  const payroll = await getWorkspacePayrollRun(context.db, workspaceId, runId);
  const allocation = payroll?.allocations.find((item) => item.id === allocationId);
  if (!payroll || !allocation || !allocation.claimAddress) notFound();

  const programId = loadPayloreConfig().PAYLORE_PAYROLL_PROGRAM_ID ?? null;
  const recoverable = allocation.status === "unclaimed";

  return (
    <main className="protected-wrap workspace-page">
      <WorkspaceNavigation
        workspaceId={workspaceId}
        workspaceName={context.workspace.workspaceName}
        role={context.workspace.role}
      />
      <header className="protected-header">
        <p className="eyebrow">Payroll &amp; claims</p>
        <h2>Recover unclaimed payroll</h2>
        <p>
          Recover an eligible allocation only while its claim remains unclaimed.
          A contributor claim cannot be reversed by the organization.
        </p>
      </header>

      <section className="surface-card" aria-labelledby="recovery-detail-heading">
        <h3 id="recovery-detail-heading">Allocation detail</h3>
        <dl className="billing-period">
          <div><dt>Payroll run</dt><dd><code>{payroll.run.id}</code></dd></div>
          <div><dt>Run created</dt><dd>{payroll.run.createdAt.toLocaleString()}</dd></div>
          <div><dt>Allocation</dt><dd><code>{allocation.id}</code></dd></div>
          <div><dt>Contributor wallet</dt><dd><code>{allocation.contributorWalletAddress}</code></dd></div>
          <div><dt>Allocation amount</dt><dd>{formatUsdc(allocation.amountBaseUnits)} wrapped USDC</dd></div>
          <div><dt>Claim state</dt><dd>{stateLabel(allocation.status)}</dd></div>
          <div><dt>Claim PDA</dt><dd><code>{allocation.claimAddress}</code></dd></div>
          <div><dt>Claim creation transaction</dt><dd><code>{allocation.transactionSignature ?? "Not recorded"}</code></dd></div>
          <div><dt>Settlement transaction</dt><dd><code>{allocation.settlementSignature ?? "Not recorded"}</code></dd></div>
          <div><dt>Allocation commitment</dt><dd><code>{payroll.run.allocationCommitment ?? "Not recorded"}</code></dd></div>
        </dl>
        {allocation.status === "claimed" ? (
          <div className="state-callout" data-state="error" role="alert">
            <span className="state-callout__signal" aria-hidden="true" />
            <p>This allocation has already been claimed and cannot be recovered by the organization.</p>
          </div>
        ) : allocation.status === "recovered" ? (
          <div className="state-callout" data-state="partial" role="status">
            <span className="state-callout__signal" aria-hidden="true" />
            <p>This allocation is already recorded as recovered. No second recovery may be submitted.</p>
          </div>
        ) : allocation.status === "settlement_pending" ? (
          <div className="state-callout" data-state="partial" role="status">
            <span className="state-callout__signal" aria-hidden="true" />
            <p>Settlement is pending. Reconcile the existing claim transaction before considering any recovery; do not submit a competing operation.</p>
          </div>
        ) : null}
      </section>

      {recoverable ? (
        <section className="surface-card" aria-labelledby="recovery-action-heading">
          <h3 id="recovery-action-heading">Recovery action</h3>
          <PayrollRecoveryAction
            workspaceId={workspaceId}
            runId={runId}
            allocationId={allocation.id}
            claimId={allocation.claimId}
            claimAddress={allocation.claimAddress}
            contributorAddress={allocation.contributorWalletAddress}
            walletAddress={context.session.walletAddress}
            programId={programId}
            canRecover={true}
          />
        </section>
      ) : null}

      <Link className="button button--secondary" href={`/workspace/${workspaceId}/recovery`}>
        Back to recovery queue
      </Link>
      <WorkspaceLegalFooter />
    </main>
  );
}
