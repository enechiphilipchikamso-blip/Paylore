import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  getWorkspaceSubscription,
  listWorkspacePayrollRuns
} from "@paylore/database";
import { PayrollRunManager } from "../../../../components/workspace/PayrollRunManager";
import {
  WorkspaceLegalFooter,
  WorkspaceNavigation
} from "../../../../components/workspace/WorkspaceNavigation";
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
  const [subscription, runs] = await Promise.all([
    getWorkspaceSubscription(context.db, workspaceId),
    listWorkspacePayrollRuns(context.db, workspaceId)
  ]);
  const editable =
    context.workspace.role === "organization_admin" &&
    (subscription?.status === "active" ||
      subscription?.status === "cancel_scheduled");

  return (
    <main className="protected-wrap workspace-page">
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

      <section className="surface-card" aria-labelledby="payroll-runs-title">
        <h2 id="payroll-runs-title">Run history</h2>
        {runs.length === 0 ? (
          <p>No payroll runs have been created in this workspace.</p>
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
    </main>
  );
}
