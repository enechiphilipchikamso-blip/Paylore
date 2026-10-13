import type { Metadata } from "next";
import Link from "next/link";
import {
  notFound,
  redirect
} from "next/navigation";
import {
  SignOutButton
} from "../../../components/auth/SignOutButton";
import {
  WORKSPACE_ROLE_LABELS
} from "../../../server/authorization-policy";
import {
  getDatabase
} from "../../../server/db";
import {
  getSessionState
} from "../../../server/session";
import {
  getWorkspaceForUser,
  getWorkspaceSubscription,
  listWorkspaceMemberships
} from "@paylore/database";
import { WorkspaceActivation } from "../../../components/workspace/WorkspaceActivation";
import { WorkspaceRetentionBanner } from "../../../components/workspace/WorkspaceRetentionBanner";
import { loadPayloreConfig } from "../../../server/config";
import { isValidSolanaAddress } from "../../../server/security";

export const metadata: Metadata = {
  title: "Workspace",
  robots: {
    index: false,
    follow: false
  }
};

export default async function WorkspacePage({
  params,
  searchParams
}: {
  params: Promise<{
    workspaceId: string;
  }>;
  searchParams: Promise<{
    created?: string;
    activated?: string;
  }>;
}) {
  const {
    workspaceId
  } = await params;

  const query =
    await searchParams;

  const sessionState =
    await getSessionState();

  if (
    sessionState.status ===
    "unauthenticated"
  ) {
    redirect(
      `/auth?next=${encodeURIComponent(
        `/workspace/${workspaceId}`
      )}`
    );
  }

  if (
    sessionState.status ===
    "inactivity_expired"
  ) {
    redirect(
      `/auth?reason=inactivity-expired&next=${encodeURIComponent(
        `/workspace/${workspaceId}`
      )}`
    );
  }

  if (
    sessionState.status ===
    "hard_expired"
  ) {
    redirect(
      `/auth?reason=hard-expired&next=${encodeURIComponent(
        `/workspace/${workspaceId}`
      )}`
    );
  }

  const db = getDatabase();
  const [workspace, memberships, subscription] =
    await Promise.all([
      getWorkspaceForUser(
        db,
        sessionState.session.userId,
        workspaceId
      ),
      listWorkspaceMemberships(
        db,
        sessionState.session.userId
      ),
      getWorkspaceSubscription(db, workspaceId)
    ]);

  if (!workspace) {
    notFound();
  }

  if (
    !subscription ||
    subscription.status === "inactive"
  ) {
    const config = loadPayloreConfig();
    const paymentConfigured = Boolean(
      config.PAYLORE_SUBSCRIPTION_RECIPIENT &&
        isValidSolanaAddress(config.PAYLORE_SUBSCRIPTION_RECIPIENT) &&
        config.PAYLORE_SUBSCRIPTION_USDC_MINT &&
        isValidSolanaAddress(config.PAYLORE_SUBSCRIPTION_USDC_MINT)
    );
    return (
      <WorkspaceActivation
        workspaceId={workspaceId}
        workspaceName={workspace.workspaceName}
        walletAddress={sessionState.session.walletAddress}
        role={workspace.role}
        paymentConfigured={paymentConfigured}
      />
    );
  }

  return (
    <div className="protected-wrap workspace-page">
      {query.activated === "1" ? (
        <div className="state-callout" data-state="success" role="status">
          <span className="state-callout__signal" aria-hidden="true" />
          <p>{workspace.workspaceName} is active and ready to use.</p>
        </div>
      ) : null}
      <nav
        className="workspace-navigation"
        aria-label="Workspace navigation"
      >
        <Link
          className="workspace-navigation__all"
          href="/app"
        >
          All workspaces
        </Link>

        <details className="workspace-switcher">
          <summary>
            <span>Current workspace</span>
            <strong>
              {workspace.workspaceName}
            </strong>
          </summary>

          <div className="workspace-switcher__menu">
            <p>Switch workspace</p>
            {memberships.map(
              (membership) => (
                <Link
                  className="workspace-switcher__option"
                  href={`/workspace/${membership.workspaceId}`}
                  key={membership.workspaceId}
                  aria-current={
                    membership.workspaceId === workspace.workspaceId
                      ? "page"
                      : undefined
                  }
                >
                  <span>
                    {membership.workspaceName}
                  </span>
                  <small>
                    {
                      WORKSPACE_ROLE_LABELS[
                        membership.role
                      ]
                    }
                  </small>
                </Link>
              )
            )}
            <Link
              className="workspace-switcher__create"
              href="/app#create-workspace"
            >
              Create workspace
            </Link>
          </div>
        </details>
      </nav>

      <WorkspaceRetentionBanner workspaceId={workspaceId} />

      {workspace.role === "contributor" ? (
        <nav className="workspace-main-nav" aria-label="Workspace features">
          <Link href={`/workspace/${workspaceId}/compensation`}>Your compensation</Link>
        </nav>
      ) : null}

      {workspace.role !== "contributor" ? (
        <nav className="workspace-main-nav" aria-label="Workspace features">
          <Link href={`/workspace/${workspaceId}/billing`}>Billing</Link>
          <Link href={`/workspace/${workspaceId}/contributors`}>Contributor Directory</Link>
          <Link href={`/workspace/${workspaceId}/contributors/invitations`}>Invitations</Link>
          <Link href={`/workspace/${workspaceId}/settings`}>Settings</Link>
          {workspace.role === "organization_admin" ? (
            <Link href={`/workspace/${workspaceId}/settings/reserve`}>Confidential reserve</Link>
          ) : null}
        </nav>
      ) : null}

      <header className="protected-header">
        <p className="eyebrow">
          Workspace
        </p>

        <h1>
          {workspace.workspaceName}
        </h1>

        <p>
          Your role:{" "}
          <strong>
            {
              WORKSPACE_ROLE_LABELS[
                workspace.role
              ]
            }
          </strong>
          .
        </p>
      </header>

      <section className="invite-state">
        {query.created === "1" ? (
          <div
            className="success-box"
            role="status"
          >
            Workspace created
          </div>
        ) : null}

        {subscription.status === "archived" ? (
          <>
            <div className="state-callout" data-state="partial" role="status">
              <span className="state-callout__signal" aria-hidden="true" />
              <p>Read-Only Archive</p>
            </div>
            <h2>Read-Only Archive</h2>
            <p>
              This workspace subscription has expired. Existing qualifying
              claims and obligations remain available for settlement, but new
              paid-only changes are unavailable until the workspace is renewed.
            </p>
            {workspace.role === "organization_admin" ? (
              <Link className="button" href={`/workspace/${workspaceId}/billing`}>
                Renew workspace
              </Link>
            ) : null}
            {workspace.role === "finance_auditor" ? (
              <p>Finance and audit records remain available in read-only mode.</p>
            ) : null}
            {workspace.role === "contributor" ? (
              <p>Outstanding contributor obligations remain available for settlement according to the product rules.</p>
            ) : null}
          </>
        ) : (
          <>
            <div className="state-callout" data-state="success" role="status">
              <span className="state-callout__signal" aria-hidden="true" />
              <p>Workspace active</p>
            </div>
            <h2>Workspace active</h2>
            <p>
              Workspace access is based on your authenticated membership and
              this workspace’s current subscription.
            </p>
            {subscription.periodEnd ? (
              <p>
                Paid through{" "}
                <time dateTime={subscription.periodEnd.toISOString()}>
                  {subscription.periodEnd.toLocaleDateString()}
                </time>
                {subscription.cancelAtPeriodEnd
                  ? " · Cancellation scheduled"
                  : " · Manual renewal"}
              </p>
            ) : null}
            <div className="hero__actions">
              {workspace.role === "organization_admin" ? (
                <>
                  <Link className="button" href={`/workspace/${workspaceId}/contributors`}>
                    Contributor Directory
                  </Link>
                  <Link className="button button--secondary" href={`/workspace/${workspaceId}/billing`}>
                    Manage billing
                  </Link>
                </>
              ) : null}
              {workspace.role === "finance_auditor" ? (
                <Link className="button button--secondary" href={`/workspace/${workspaceId}/billing`}>
                  View billing
                </Link>
              ) : null}
            </div>
          </>
        )}

        <p className="workspace-card__meta">
          Workspace ID:{" "}
          {workspace.workspaceId}
        </p>

        <div className="protected-actions">
          <SignOutButton />
        </div>
      </section>
      <footer className="workspace-legal-footer">
        <Link href="/terms">Terms</Link>
        <Link href="/privacy">Privacy</Link>
        <Link href="/security">Security</Link>
      </footer>
    </div>
  );
}