import Link from "next/link";
import {
  WORKSPACE_ROLE_LABELS,
  type WorkspaceRole
} from "../../server/authorization-policy";
import { WorkspaceRetentionBanner } from "./WorkspaceRetentionBanner";
import { WorkspaceNavigationLinks } from "./WorkspaceNavigationLinks";

type WorkspaceMembershipView = {
  workspaceId: string;
  workspaceName: string;
  role: WorkspaceRole;
};

export function WorkspaceNavigation({
  workspaceId,
  workspaceName,
  role,
  memberships = [],
  showRetentionBanner = true
}: {
  workspaceId: string;
  workspaceName: string;
  role: WorkspaceRole;
  memberships?: WorkspaceMembershipView[];
  showRetentionBanner?: boolean;
}) {
  return (
    <header className="workspace-app-header">
      <div className="workspace-app-header__top">
        <div className="workspace-app-header__identity">
          <Link aria-label="Paylore home" className="workspace-app-header__brand" href="/">
            Paylore
          </Link>
          <span aria-hidden="true" className="workspace-app-header__divider" />
          <div className="workspace-app-header__workspace">
            <p className="eyebrow">Workspace</p>
            <h1>{workspaceName}</h1>
            <span className="workspace-card__role">{WORKSPACE_ROLE_LABELS[role]}</span>
          </div>
        </div>

        <div className="workspace-app-header__account">
          {memberships.length > 1 ? (
            <details className="workspace-account-switcher">
              <summary>Switch workspace</summary>
              <div className="workspace-account-switcher__menu">
                {memberships.map((membership) => (
                  <Link
                    aria-current={membership.workspaceId === workspaceId ? "page" : undefined}
                    href={`/workspace/${membership.workspaceId}`}
                    key={membership.workspaceId}
                  >
                    <span>{membership.workspaceName}</span>
                    <small>{WORKSPACE_ROLE_LABELS[membership.role]}</small>
                  </Link>
                ))}
                <Link href="/app#create-workspace">Create workspace</Link>
              </div>
            </details>
          ) : (
            <Link className="workspace-app-header__all" href="/app">
              All workspaces
            </Link>
          )}
        </div>
      </div>

      <WorkspaceNavigationLinks workspaceId={workspaceId} role={role} />

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
