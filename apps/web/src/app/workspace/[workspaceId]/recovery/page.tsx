import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { getWorkspacePayrollRecoveryQueue } from "@paylore/database";
import {
  WorkspaceLegalFooter,
  WorkspaceNavigation
} from "../../../../components/workspace/WorkspaceNavigation";
import { getWorkspacePageContext } from "../../../../server/workspace-page-context";

export const metadata: Metadata = {
  title: "Payroll recovery",
  robots: { index: false, follow: false }
};

export const dynamic = "force-dynamic";

function formatUsdc(baseUnits: string): string {
  const amount = BigInt(baseUnits);
  const whole = amount / 1_000_000n;
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export default async function WorkspaceRecoveryQueuePage({
  params
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const context = await getWorkspacePageContext(
    workspaceId,
    `/workspace/${workspaceId}/recovery`
  );
  if (context.workspace.role !== "organization_admin") notFound();

  const recoveryQueue = await getWorkspacePayrollRecoveryQueue(context.db, workspaceId);

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
          Review an eligible allocation only while its claim remains unclaimed.
          A contributor claim cannot be reversed by the organization.
        </p>
      </header>

      <section className="surface-card" aria-labelledby="recovery-queue-heading">
        <h3 id="recovery-queue-heading">Recovery queue</h3>
        <p className="notice" role="note">
          This list includes only allocations recorded as unclaimed with a Claim
          PDA. Financial recovery is unavailable until the confidential reserve
          restoration can be verified; reviewing an item does not move funds or
          change its claim state.
        </p>
        {recoveryQueue.length === 0 ? (
          <p>No unclaimed payroll allocations are currently in the recovery queue.</p>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Payroll run</th>
                  <th scope="col">Created</th>
                  <th scope="col">Contributor wallet</th>
                  <th scope="col">Allocation (wrapped USDC)</th>
                  <th scope="col">Claim state</th>
                  <th scope="col">Claim PDA</th>
                  <th scope="col">Details</th>
                </tr>
              </thead>
              <tbody>
                {recoveryQueue.map((allocation) => (
                  <tr key={allocation.id}>
                    <td><code>{allocation.runId}</code></td>
                    <td>{allocation.runCreatedAt.toLocaleString()}</td>
                    <td><code>{allocation.contributorWalletAddress}</code></td>
                    <td>{formatUsdc(allocation.amountBaseUnits)} wrapped USDC</td>
                    <td>Unclaimed</td>
                    <td><code>{allocation.claimAddress}</code></td>
                    <td>
                      <Link href={`/workspace/${workspaceId}/recovery/${allocation.runId}/${allocation.id}`}>
                        Review allocation
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
