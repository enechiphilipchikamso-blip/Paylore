import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getWorkspacePayrollRun, listWorkspaceContributors } from "@paylore/database";
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

const RUN_STATUS: Record<string, { label: string; tone: "success" | "partial" | "error" | "neutral" }> = {
  draft: { label: "Draft", tone: "neutral" },
  commit_pending: { label: "Awaiting Claim PDAs", tone: "partial" },
  submitting: { label: "Partially submitted", tone: "partial" },
  committed: { label: "Claim PDAs finalized", tone: "success" },
  complete: { label: "Complete", tone: "success" },
  cancelled: { label: "Cancelled", tone: "error" }
};

const ALLOCATION_STATUS: Record<string, { label: string; tone: "success" | "partial" | "error" | "neutral" }> = {
  draft: { label: "Awaiting Claim PDA", tone: "neutral" },
  unclaimed: { label: "Unclaimed", tone: "partial" },
  settlement_pending: { label: "Settlement pending", tone: "partial" },
  claimed: { label: "Claimed", tone: "success" },
  recovery_pending: { label: "Recovery pending", tone: "partial" },
  recovered: { label: "Recovered", tone: "neutral" }
};

function statusView(
  map: typeof RUN_STATUS,
  status: string
) {
  return map[status] ?? { label: status.replaceAll("_", " "), tone: "neutral" as const };
}

function shortReference(value: string) {
  return value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-8)}` : value;
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
  const [payrollRun, contributors] = await Promise.all([
    getWorkspacePayrollRun(context.db, workspaceId, runId),
    listWorkspaceContributors(context.db, workspaceId)
  ]);
  if (!payrollRun) notFound();
  const payrollProgramId =
    loadPayloreConfig().PAYLORE_PAYROLL_PROGRAM_ID ?? null;
  const canCommit =
    context.workspace.role === "organization_admin" &&
    ["commit_pending", "submitting"].includes(payrollRun.run.status);

  const contributorNames = new Map(
    contributors.map((contributor) => [contributor.id, contributor.displayName])
  );
  const runStatus = statusView(RUN_STATUS, payrollRun.run.status);
  const isAdmin = context.workspace.role === "organization_admin";
  const canCancel =
    isAdmin &&
    payrollRun.run.status === "commit_pending" &&
    payrollRun.run.submissionSignature === null &&
    payrollRun.allocations.every(
      (allocation) =>
        allocation.claimAddress === null &&
        allocation.transactionSignature === null
    );
  const finalizedClaims = payrollRun.allocations.filter(
    (allocation) => allocation.claimAddress !== null
  ).length;

  return (
    <div className="protected-wrap workspace-page">
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
            ? "Manager confirmation is recorded. No on-chain commitment has been submitted yet."
            : payrollRun.run.status === "committed"
              ? "All Claim PDAs are finalized. Contributor settlement remains a separate step."
              : payrollRun.run.status === "submitting"
                ? "Some Claim PDAs are finalized. Retry submission to finish the remaining allocations."
                : `Current status: ${runStatus.label}`}
        </p>
      </header>
      <div className="reserve-actions payroll-run">
        <section className="reserve-panel" aria-labelledby="payroll-run-summary-heading">
          <header className="reserve-panel__header reserve-panel__header--split">
            <h3 id="payroll-run-summary-heading">Run summary</h3>
            <span className="payroll-status" data-tone={runStatus.tone}>{runStatus.label}</span>
          </header>
          <dl className="reserve-balances">
            <div>
              <dt>Total</dt>
              <dd><span className="reserve-amount__value financial-value">{formatUsdc(payrollRun.run.totalAmountBaseUnits)} USDC</span></dd>
            </div>
            <div>
              <dt>Allocations</dt>
              <dd><span className="reserve-amount__value numeric">{payrollRun.allocations.length}</span></dd>
            </div>
            <div>
              <dt>Claim PDAs finalized</dt>
              <dd><span className="reserve-amount__value numeric">{finalizedClaims} of {payrollRun.allocations.length}</span></dd>
            </div>
          </dl>
          <dl className="reserve-facts">
            <div><dt>Created</dt><dd>{payrollRun.run.createdAt.toLocaleString()}</dd></div>
            <div>
              <dt>Manager confirmed</dt>
              <dd>{payrollRun.run.managerConfirmedAt?.toLocaleString() ?? "Not confirmed"}</dd>
            </div>
            <div className="reserve-facts__wide"><dt>Run ID</dt><dd><code>{payrollRun.run.id}</code></dd></div>
            <div className="reserve-facts__wide">
              <dt>Allocation commitment</dt>
              <dd>{payrollRun.run.allocationCommitment ? <code>{payrollRun.run.allocationCommitment}</code> : "Not created"}</dd>
            </div>
            <div className="reserve-facts__wide">
              <dt>Submission transaction</dt>
              <dd>{payrollRun.run.submissionSignature ? <code>{payrollRun.run.submissionSignature}</code> : "Not submitted"}</dd>
            </div>
          </dl>
        </section>

        {canCommit ? (
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
        ) : null}
        <PayrollRunActions
          workspaceId={workspaceId}
          runId={payrollRun.run.id}
          canCancel={canCancel}
        />

        <section className="reserve-panel" aria-labelledby="payroll-allocations-title">
          <header className="reserve-panel__header">
            <h3 id="payroll-allocations-title">Allocations</h3>
            <p>Each allocation becomes one Claim PDA. Long on-chain references are shortened; hover or select them to read the full value.</p>
          </header>
          {payrollRun.allocations.length === 0 ? (
            <p>No allocation records are available.</p>
          ) : (
            <ul className="payroll-allocations">
              {payrollRun.allocations.map((allocation) => {
                const eligibility = assessPayrollRecoveryEligibility({
                  claimState: allocation.status,
                  claimAddress: allocation.claimAddress,
                  escrowStatus: allocation.escrowStatus
                });
                const canRecover = eligibility.state === "eligible" || eligibility.state === "reconcile";
                const allocationStatus = statusView(ALLOCATION_STATUS, allocation.status);
                return (
                  <li className="payroll-allocation" id={`allocation-${allocation.id}`} key={allocation.id}>
                    <div className="payroll-allocation__header">
                      <div className="payroll-allocation__who">
                        <strong>{contributorNames.get(allocation.contributorId) ?? "Contributor"}</strong>
                        {allocation.contributorWalletAddress ? (
                          <code title={allocation.contributorWalletAddress}>{shortReference(allocation.contributorWalletAddress)}</code>
                        ) : null}
                      </div>
                      <span className="reserve-amount__value financial-value">{formatUsdc(allocation.amountBaseUnits)} USDC</span>
                      <span className="payroll-status" data-tone={allocationStatus.tone}>{allocationStatus.label}</span>
                    </div>
                    <dl className="reserve-facts">
                      <div>
                        <dt>Claim PDA</dt>
                        <dd>{allocation.claimAddress ? <code title={allocation.claimAddress}>{allocation.claimAddress}</code> : "Not created"}</dd>
                      </div>
                      <div>
                        <dt>Transaction</dt>
                        <dd>{allocation.transactionSignature ? <code title={allocation.transactionSignature}>{shortReference(allocation.transactionSignature)}</code> : "Not submitted"}</dd>
                      </div>
                      {isAdmin ? (
                        <div className="reserve-facts__wide">
                          <dt>Recovery</dt>
                          <dd>
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
                          </dd>
                        </div>
                      ) : null}
                    </dl>
                  </li>
                );
              })}
            </ul>
          )}
        </section>
        <div className="reserve-panel__actions">
          <Link className="button button--secondary" href={`/workspace/${workspaceId}/payroll`}>
            Back to payroll runs
          </Link>
        </div>
      </div>
      <WorkspaceLegalFooter />
    </div>
  );
}
