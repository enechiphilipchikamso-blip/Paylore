import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getWorkspaceSubscription,
  listWorkspacePayrollRecoveryQueue,
  listWorkspacePayrollRuns
} from "@paylore/database";
import { PayrollRunManager } from "../../../../components/workspace/PayrollRunManager";
import {
  WorkspaceLegalFooter,
  WorkspaceNavigation
} from "../../../../components/workspace/WorkspaceNavigation";
import { assessPayrollRecoveryEligibility } from "../../../../server/payroll-recovery-queue-policy";
import { getWorkspacePageContext } from "../../../../server/workspace-page-context";

export const metadata: Metadata = {
  title: "Payroll runs",
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

function payrollStatus(status: string) {
  switch (status) {
    case "awaiting_confirmation":
      return "Awaiting manager confirmation";
    case "commit_pending":
      return "Confirmed; on-chain commitment pending";
    case "submitting":
      return "Submitting to Solana";
    case "confirming":
      return "Waiting for finality";
    case "complete":
      return "Complete";
    case "committed":
      return "Claim PDAs finalized; settlement pending";
    case "partial_failure":
      return "Partially completed; reconciliation required";
    case "cancelled":
      return "Cancelled before commitment";
    default:
      return "Status requires review";
  }
}

export default async function WorkspacePayrollPage({
  params
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const context = await getWorkspacePageContext(
    workspaceId,
    `/workspace/${workspaceId}/payroll`
  );
  if (context.workspace.role === "contributor") notFound();
  const [subscription, runs, recoveryQueue] = await Promise.all([
    getWorkspaceSubscription(context.db, workspaceId),
    listWorkspacePayrollRuns(context.db, workspaceId),
    context.workspace.role === "organization_admin"
      ? listWorkspacePayrollRecoveryQueue(context.db, workspaceId)
      : Promise.resolve([])
  ]);
  const editable =
    context.workspace.role === "organization_admin" &&
    (subscription?.status === "active" ||
      subscription?.status === "cancel_scheduled");

  return (
    <div className="protected-wrap workspace-page">
      <WorkspaceNavigation
        workspaceId={workspaceId}
        workspaceName={context.workspace.workspaceName}
        role={context.workspace.role}
      />
      <header className="protected-header">
        <p className="eyebrow">Payroll</p>
        <h2>Payroll runs</h2>
        <p>
          Review workspace-scoped payroll imports and their explicit processing
          state. A saved draft is not an on-chain payment or a completed run.
        </p>
      </header>
      {editable ? (
        <PayrollRunManager workspaceId={workspaceId} />
      ) : context.workspace.role === "organization_admin" ? (
        <section className="surface-card">
          <div className="state-callout" data-state="partial" role="status">
            <span className="state-callout__signal" aria-hidden="true" />
            <p>
              This workspace is in Read-Only Archive Mode. Renew the workspace
              before creating payroll runs.
            </p>
          </div>
          <Link className="button" href={`/workspace/${workspaceId}/billing`}>
            Manage billing
          </Link>
        </section>
      ) : null}

      {context.workspace.role === "organization_admin" ? (
        <section className="surface-card" aria-labelledby="payroll-recovery-queue-title">
          <h2 id="payroll-recovery-queue-title">Recovery queue</h2>
          <p>
            Review allocations across this workspace. Paylore checks the Claim PDA transition
            and finalized confidential balance movement before recording a recovery.
          </p>
          {recoveryQueue.length === 0 ? (
            <div className="workspace-empty-state">
              <h3>No allocations need recovery review</h3>
              <p>Eligible unclaimed allocations will appear here when the workspace has payroll that may be reviewed for recovery.</p>
            </div>
          ) : (
            <>
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th scope="col">Allocation</th>
                      <th scope="col">Payroll run</th>
                      <th scope="col">Contributor</th>
                      <th scope="col">Amount (USDC)</th>
                      <th scope="col">Claim PDA</th>
                      <th scope="col">Recorded Claim state</th>
                      <th scope="col">Eligibility</th>
                      <th scope="col">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {recoveryQueue.map((item) => {
                      const eligibility = assessPayrollRecoveryEligibility({
                        claimState: item.claimState,
                        claimAddress: item.claimAddress,
                        escrowStatus: item.escrowStatus
                      });
                      return (
                        <tr key={item.allocationId}>
                          <td>{item.allocationId}</td>
                          <td>
                            <Link href={`/workspace/${workspaceId}/payroll/${item.runId}`}>
                              {item.runId}
                            </Link>
                            <p>{payrollStatus(item.runStatus)}</p>
                          </td>
                          <td>
                            {item.contributorName}
                            <p>{item.contributorId}</p>
                          </td>
                          <td>{formatUsdc(item.amountBaseUnits)}</td>
                          <td>{item.claimAddress ?? "Not created"}</td>
                          <td>{item.claimState}</td>
                          <td>{eligibility.label}</td>
                          <td>
                            <Link href={`/workspace/${workspaceId}/payroll/${item.runId}#allocation-${item.allocationId}`}>
                              Review allocation
                            </Link>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              <p>All payroll allocations in this workspace are included.</p>
            </>
          )}
        </section>
      ) : null}

      <section className="surface-card" aria-labelledby="payroll-runs-title">
        <h2 id="payroll-runs-title">Run history</h2>
        {runs.length === 0 ? (
          <div className="workspace-empty-state">
            <h3>No payroll runs yet</h3>
            <p>Workspace payroll history will appear here after an administrator creates and records a run.</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Created</th>
                  <th scope="col">Total (USDC)</th>
                  <th scope="col">Status</th>
                  <th scope="col">Transaction</th>
                  <th scope="col">Details</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td>{run.createdAt.toLocaleString()}</td>
                    <td>{formatUsdc(run.totalAmountBaseUnits)}</td>
                    <td>{payrollStatus(run.status)}</td>
                    <td>{run.submissionSignature ?? "Not submitted"}</td>
                    <td>
                      <Link href={`/workspace/${workspaceId}/payroll/${run.id}`}>
                        View run
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <WorkspaceLegalFooter />
    </div>
  );
}
