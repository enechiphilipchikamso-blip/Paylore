import Link from "next/link";
import {
  WORKSPACE_ROLE_LABELS,
  type WorkspaceRole
} from "../../server/authorization-policy";
import { WorkspaceRetentionBanner } from "./WorkspaceRetentionBanner";

export function WorkspaceNavigation({
  workspaceId,
  workspaceName,
  role,
  showRetentionBanner = true
}: {
  workspaceId: string;
  workspaceName: string;
  role: WorkspaceRole;
  showRetentionBanner?: boolean;
}) {
  const base = `/workspace/${workspaceId}`;

  return (
    <header className="workspace-app-header">
      <div>
        <Link href="/app">All workspaces</Link>
        <h1>{workspaceName}</h1>
        <p>{WORKSPACE_ROLE_LABELS[role]}</p>
      </div>
      <nav aria-label="Workspace navigation" className="workspace-app-nav">
        <Link href={base}>Home</Link>
        {role === "contributor" ? (
          <Link href={`${base}/compensation`}>Your compensation</Link>
        ) : null}
        {role !== "contributor" ? (
          <>
            <Link href={`${base}/billing`}>Billing</Link>
            <Link href={`${base}/contributors`}>Contributors</Link>
            <Link href={`${base}/contributors/invitations`}>Invitations</Link>
            <Link href={`${base}/payroll`}>Payroll</Link>
            <Link href={`${base}/ledger`}>Ledger</Link>
            <Link href={`${base}/notifications`}>Notifications</Link>
            <Link href={`${base}/gas-tank`}>Gas Tank</Link>
            <Link href={`${base}/settings`}>Settings</Link>
            {role === "organization_admin" ? (
              <Link href={`${base}/settings/reserve`}>Reserve</Link>
            ) : null}
          </>
        ) : null}
      </nav>
      {showRetentionBanner ? (
        <WorkspaceRetentionBanner workspaceId={workspaceId} />
      ) : null}
    </header>
  );
}

export function WorkspaceLegalFooter() {
  return (
    <footer className="workspace-legal-footer">
      <Link href="/terms">Terms</Link>
      <Link href="/privacy">Privacy</Link>
      <Link href="/security">Security</Link>
    </footer>
  );
}
