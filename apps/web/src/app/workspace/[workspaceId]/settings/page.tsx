import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import {
  WorkspaceLegalFooter,
  WorkspaceNavigation
} from "../../../../components/workspace/WorkspaceNavigation";
import { getWorkspacePageContext } from "../../../../server/workspace-page-context";

export const metadata: Metadata = {
  title: "Workspace settings",
  robots: { index: false, follow: false }
};

export const dynamic = "force-dynamic";

export default async function WorkspaceSettingsPage({
  params
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const context = await getWorkspacePageContext(
    workspaceId,
    `/workspace/${workspaceId}/settings`
  );
  if (context.workspace.role === "contributor") notFound();

  return (
    <main className="protected-wrap workspace-page">
      <WorkspaceNavigation
        workspaceId={workspaceId}
        workspaceName={context.workspace.workspaceName}
        role={context.workspace.role}
      />
      <header className="protected-header">
        <p className="eyebrow">Workspace</p>
        <h2>Settings</h2>
      </header>
      <section className="card-grid settings-grid">
        <article className="card">
          <h3>Workspace</h3>
          <dl className="settings-details">
            <div><dt>Workspace name</dt><dd>{context.workspace.workspaceName}</dd></div>
            <div><dt>Workspace ID</dt><dd><code>{workspaceId}</code></dd></div>
            <div><dt>Administrator</dt><dd>{context.workspace.role === "organization_admin" ? "You" : "Workspace administrator"}</dd></div>
          </dl>
        </article>
        <article className="card">
          <h3>Billing</h3>
          <p>Review subscription status and payment history.</p>
          <Link href={`/workspace/${workspaceId}/billing`}>Manage billing</Link>
        </article>
        <article className="card">
          <h3>Reserve</h3>
          <p>Manage this workspace’s confidential payroll reserve.</p>
          <Link href={`/workspace/${workspaceId}/settings/reserve`}>Manage confidential reserve</Link>
        </article>
        {context.workspace.role === "organization_admin" ? (
          <article className="card">
            <h3>Data retention</h3>
            <p>Review workspace retention and request safe application-data deletion.</p>
            <Link href={`/workspace/${workspaceId}/settings/deletion`}>Review data retention</Link>
          </article>
        ) : null}
        <article className="card">
          <h3>Security</h3>
          <p>
            Review authentication and workspace-access settings. Learn more in{" "}
            <Link href="/terms">Terms</Link> and{" "}
            <Link href="/privacy">Privacy</Link>.
          </p>
          <Link href="/security">Security overview</Link>
        </article>
      </section>
      <WorkspaceLegalFooter />
    </main>
  );
}
