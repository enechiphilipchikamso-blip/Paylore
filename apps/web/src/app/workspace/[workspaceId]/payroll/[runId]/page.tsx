import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getWorkspacePayrollRun } from "@paylore/database";
import { PayrollRunActions } from "../../../../../components/workspace/PayrollRunActions";
import { PayrollClaimCommitAction } from "../../../../../components/workspace/PayrollClaimCommitAction";
import { PayrollRecoveryAction } from "../../../../../components/workspace/PayrollRecoveryAction";
import {
  WorkspaceLegalFooter,
  WorkspaceNavigation
} from "../../../../../components/workspace/WorkspaceNavigation";
import { assessPayrollRecoveryEligibility } from "../../../../../server/payroll-recovery-queue-policy";
import { getWorkspacePageContext } from "../../../../../server/workspace-page-context";
import { loadPayloreConfig } from "../../../../../server/config";

export const metadata: Metadata = {
  title: "Payroll run details",
  robots: { index: false, follow: false }
};

export const dynamic = "force-dynamic";

function formatUsdc(baseUnits: string) {
  const amount = BigInt(baseUnits);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export default async function PayrollRunDetailPage({
  params
}: {
  params: Promise<{ workspaceId: string; runId: string }>;
}) {
  const { workspaceId, runId } = await params;
  const context = await getWorkspacePageContext(
    workspaceId,
    `/workspace/${workspaceId}/payroll/${runId}`
  );
  if (context.workspace.role === "contributor") notFound();
  const payrollRun = await getWorkspacePayrollRun(
    context.db,
    workspaceId,
    runId
  );
  if (!payrollRun) notFound();
  const payrollProgramId =
    loadPayloreConfig().PAYLORE_PAYROLL_PROGRAM_ID ?? null;
  const canCommit =
    context.workspace.role === "organization_admin" &&
    ["commit_pending", "submitting"].includes(payrollRun.run.status);

  return (
    <main className="protected-wrap workspace-page">
      <WorkspaceNavigation
        workspaceId={workspaceId}
        workspaceName={context.workspace.workspaceName}
        role={context.workspace.role}
      />
      <header className="protected-header">
        <p className="eyebrow">Payroll run</p>
        <h2>Run details</h2>
        <p>
          {payrollRun.run.status === "commit_pending"
            ? "Manager confirmation is recorded. No on-chain commitment has been submitted."
            : payrollRun.run.status === "committed"
              ? "All Claim PDAs are finalized. Contributor settlement remains a separate step."
              : payrollRun.run.status === "submitting"
                ? "Some Claim PDAs are finalized. Retry submission to finish the remaining allocations."
                : `Current status: ${payrollRun.run.status}`}
        </p>
      </header>
      <section className="surface-card">
        <dl>
          <dt>Run ID</dt>
          <dd>{payrollRun.run.id}</dd>
          <dt>Created</dt>
          <dd>{payrollRun.run.createdAt.toLocaleString()}</dd>
          <dt>Manager confirmed</dt>
          <dd>
            {payrollRun.run.managerConfirmedAt?.toLocaleString() ??
              "Not confirmed"}
          </dd>
          <dt>Total</dt>
          <dd>{formatUsdc(payrollRun.run.totalAmountBaseUnits)} USDC</dd>
          <dt>Allocations</dt>
          <dd>{payrollRun.allocations.length}</dd>
          <dt>Allocation commitment</dt>
          <dd>{payrollRun.run.allocationCommitment ?? "Not created"}</dd>
          <dt>Submission transaction</dt>
          <dd>{payrollRun.run.submissionSignature ?? "Not submitted"}</dd>
        </dl>
      </section>
      <section className="surface-card" aria-label="Payroll run actions">
        <PayrollClaimCommitAction
          workspaceId={workspaceId}
          runId={payrollRun.run.id}
          walletAddress={context.session.walletAddress}
          programId={payrollProgramId}
          allocationCommitment={payrollRun.run.allocationCommitment}
          claims={payrollRun.allocations.map((allocation) => ({
            claimId: allocation.claimId,
            contributorAddress: allocation.contributorWalletAddress,
            amountCommitment: allocation.amountCommitment ?? "",
            amountCommitmentProof: allocation.amountCommitmentProof ?? [],
            amountCommitmentLeafIndex: allocation.amountCommitmentLeafIndex ?? -1
          }))}
          canCommit={canCommit}
        />
        <PayrollRunActions
          workspaceId={workspaceId}
          runId={payrollRun.run.id}
          canCancel={
            context.workspace.role === "organization_admin" &&
            payrollRun.run.status === "commit_pending" &&
            payrollRun.run.submissionSignature === null &&
            payrollRun.allocations.every(
              (allocation) =>
                allocation.claimAddress === null &&
                allocation.transactionSignature === null
            )
          }
        />
      </section>
      <section className="surface-card" aria-labelledby="payroll-allocations-title">
        <h2 id="payroll-allocations-title">Allocations</h2>
        {payrollRun.allocations.length === 0 ? (
          <p>No allocation records are available.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Contributor</th>
                  <th scope="col">USDC</th>
                  <th scope="col">Claim PDA</th>
                  <th scope="col">Status</th>
                  <th scope="col">Transaction</th>
                  {context.workspace.role === "organization_admin" ? (
                    <th scope="col">Recovery</th>
                  ) : null}
                </tr>
              </thead>
              <tbody>
                {payrollRun.allocations.map((allocation) => {
                  const eligibility = assessPayrollRecoveryEligibility({
                    claimState: allocation.status,
                    claimAddress: allocation.claimAddress,
                    escrowStatus: allocation.escrowStatus
                  });
                  const canRecover = eligibility.state === "eligible" || eligibility.state === "reconcile";
                  return (
                    <tr id={`allocation-${allocation.id}`} key={allocation.id}>
                      <td>{allocation.contributorId}</td>
                      <td>{formatUsdc(allocation.amountBaseUnits)}</td>
                      <td>{allocation.claimAddress ?? "Not created"}</td>
                      <td>{allocation.status}</td>
                      <td>{allocation.transactionSignature ?? "Not submitted"}</td>
                      {context.workspace.role === "organization_admin" ? (
                        <td>
                          {canRecover ? (
                            <PayrollRecoveryAction
                              workspaceId={workspaceId}
                              runId={payrollRun.run.id}
                              allocationId={allocation.id}
                              claimId={allocation.claimId}
                              claimAddress={allocation.claimAddress ?? ""}
                              contributorAddress={allocation.contributorWalletAddress}
                              walletAddress={context.session.walletAddress}
                              programId={payrollProgramId}
                              canRecover={canRecover}
                            />
                          ) : eligibility.label}
                        </td>
                      ) : null}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <Link className="button button--secondary" href={`/workspace/${workspaceId}/payroll`}>
        Back to payroll runs
      </Link>
      <WorkspaceLegalFooter />
    </main>
  );
}
