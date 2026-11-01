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
import { loadPayloreConfig } from "../../../server/config";
import { isValidSolanaAddress } from "../../../server/security";
import { getWorkspaceSetupProgress } from "../../../server/workspace-setup-progress";
import {
  WorkspaceLegalFooter,
  WorkspaceNavigation
} from "../../../components/workspace/WorkspaceNavigation";

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

  const setupProgress =
    workspace.role === "organization_admin" &&
    (subscription.status === "active" || subscription.status === "cancel_scheduled")
      ? await getWorkspaceSetupProgress(
          db,
          workspaceId,
          sessionState.session.walletAddress
        )
      : null;

  return (
    <div className="protected-wrap workspace-page">
      <WorkspaceNavigation
        workspaceId={workspaceId}
        workspaceName={workspace.workspaceName}
        role={workspace.role}
        memberships={memberships.map((membership) => ({
          workspaceId: membership.workspaceId,
          workspaceName: membership.workspaceName,
          role: membership.role
        }))}
      />
      {query.activated === "1" ? (
        <div className="state-callout" data-state="success" role="status">
          <span className="state-callout__signal" aria-hidden="true" />
          <p>{workspace.workspaceName} subscription is active.</p>
          {setupProgress && !setupProgress.complete ? (
            <p>Finish Gas Tank funding and confidential Reserve setup below before running private payroll.</p>
          ) : null}
        </div>
      ) : null}
      <header className="protected-header workspace-home-heading">
        <p className="eyebrow">Workspace home</p>
        <h2>Workspace overview</h2>
        <p>
          A clear view of workspace status and the actions available to
          {workspace.role === "organization_admin"
            ? " your administrator team."
            : workspace.role === "finance_auditor"
              ? " your finance and audit role."
              : " you as a contributor."}
        </p>
      </header>

      {setupProgress && !setupProgress.complete ? (
        <section className="workspace-setup" aria-labelledby="workspace-setup-heading">
          <div className="state-callout" data-state="partial" role="status">
            <span className="state-callout__signal" aria-hidden="true" />
            <p>Workspace setup is incomplete. Finish the Gas Tank setup and confidential reserve checks to prepare this workspace for private payroll.</p>
          </div>
          <section className="surface-card workspace-setup__card">
            <p className="eyebrow">Getting started</p>
            <h2 id="workspace-setup-heading">Finish setting up this workspace</h2>
            <ol className="workspace-setup__steps">
              <li className="workspace-setup__step" data-state={setupProgress.gasTank.status}>
                <span className="workspace-setup__number" aria-hidden="true">1</span>
                <div className="workspace-setup__content">
                  <p className="eyebrow">First</p>
                  <h3>Gas Tank setup</h3>
                  {setupProgress.gasTank.status === "not_initialized" ? (
                    <p>Create the workspace Gas Tank. Paylore protects its signing key on the server; the workspace administrator supplies the SOL.</p>
                  ) : setupProgress.gasTank.status === "funding_required" ? (
                    <p>The Gas Tank needs more SOL. Transfer SOL from the administrator wallet to the Gas Tank before starting confidential Reserve setup. Paylore checks the live balance against transaction fees and rent before submitting.</p>
                  ) : setupProgress.gasTank.status === "balance_unavailable" ? (
                    <p>Paylore could not verify the live Gas Tank balance. Open the Gas Tank page and refresh its balance before starting Reserve setup.</p>
                  ) : (
                    <p>The Gas Tank is initialized and its live balance is available. Reserve setup will check a conservative rent allowance and network-fee buffer again before submitting any transaction.</p>
                  )}
                  {setupProgress.gasTank.address ? (
                    <p className="workspace-setup__address">Gas Tank address: <code>{setupProgress.gasTank.address}</code></p>
                  ) : null}
                  {setupProgress.gasTank.balanceSol !== null && setupProgress.gasTank.status !== "balance_unavailable" ? (
                    <p className="workspace-setup__balance">Live balance: {setupProgress.gasTank.balanceSol} SOL</p>
                  ) : null}
                  <Link className="button button--secondary" href={`/workspace/${workspaceId}/gas-tank`}>
                    {setupProgress.gasTank.status === "not_initialized" ? "Set up Gas Tank" : "Review and fund Gas Tank"}
                  </Link>
                </div>
              </li>
              <li className="workspace-setup__step" data-state={setupProgress.reserve.status}>
                <span className="workspace-setup__number" aria-hidden="true">2</span>
                <div className="workspace-setup__content">
                  <p className="eyebrow">Next</p>
                  <h3>Confidential reserve setup</h3>
                  {setupProgress.reserve.status === "key_custody_required" ? (
                    <p>After the Gas Tank is initialized and funded, configure encrypted Reserve signing-key custody, then initialize its confidential Token-2022 account and Payroll Program reserve state.</p>
                  ) : setupProgress.reserve.status === "workspace_program_not_initialized" ? (
                    <p>The Paylore Program workspace account is not initialized. Reserve setup will initialize that workspace state once with your connected admin wallet, then continue configuring the confidential reserve.</p>
                  ) : setupProgress.reserve.status === "unavailable" ? (
                    <p>Paylore could not verify the current Reserve state. Open Reserve settings and refresh the on-chain check before trying setup again.</p>
                  ) : (
                    <p>The Reserve still owns and authorizes its token account. When the Gas Tank has enough SOL, initialize or reconcile the confidential account and its Payroll Program reserve state.</p>
                  )}
                  <Link className="button" href={`/workspace/${workspaceId}/settings/reserve`}>
                    Open confidential reserve
                  </Link>
                </div>
              </li>
            </ol>
          </section>
        </section>
      ) : null}

      {workspace.role === "organization_admin" ? (
        <section className="workspace-quick-links" aria-labelledby="workspace-tools-heading">
          <header className="workspace-section-heading">
            <div>
              <p className="eyebrow">Workspace controls</p>
              <h2 id="workspace-tools-heading">Workspace tools</h2>
              <p>Open the workspace area you need without leaving this dashboard.</p>
            </div>
          </header>
          <div className="workspace-quick-links__grid">
            <Link className="workspace-quick-link" href={`/workspace/${workspaceId}/contributors`}>
              <span><strong>Contributors</strong><small>Review the directory and onboarding status.</small></span>
              <span aria-hidden="true" className="workspace-quick-link__arrow">→</span>
            </Link>
            <Link className="workspace-quick-link" href={`/workspace/${workspaceId}/payroll`}>
              <span><strong>Payroll</strong><small>Prepare runs and review contributor allocations.</small></span>
              <span aria-hidden="true" className="workspace-quick-link__arrow">→</span>
            </Link>
            <Link className="workspace-quick-link" href={`/workspace/${workspaceId}/gas-tank`}>
              <span><strong>Gas Tank</strong><small>Check the sponsored network-fee balance and activity.</small></span>
              <span aria-hidden="true" className="workspace-quick-link__arrow">→</span>
            </Link>
            <Link className="workspace-quick-link" href={`/workspace/${workspaceId}/billing`}>
              <span><strong>Billing</strong><small>Review the subscription and payment history.</small></span>
              <span aria-hidden="true" className="workspace-quick-link__arrow">→</span>
            </Link>
            <Link className="workspace-quick-link" href={`/workspace/${workspaceId}/ledger`}>
              <span><strong>Workspace ledger</strong><small>Review workspace-scoped financial and operational entries.</small></span>
              <span aria-hidden="true" className="workspace-quick-link__arrow">→</span>
            </Link>
            <Link className="workspace-quick-link" href={`/workspace/${workspaceId}/notifications`}>
              <span><strong>Notifications</strong><small>Review durable workspace updates.</small></span>
              <span aria-hidden="true" className="workspace-quick-link__arrow">→</span>
            </Link>
          </div>
        </section>
      ) : null}

      {workspace.role === "finance_auditor" ? (
        <section className="workspace-quick-links" aria-labelledby="finance-overview-heading">
          <header className="workspace-section-heading">
            <div>
              <p className="eyebrow">Finance &amp; audit</p>
              <h2 id="finance-overview-heading">Workspace records</h2>
              <p>Review payroll, contributor records and operational activity. These views do not include administrator controls.</p>
            </div>
          </header>
          <p className="notice" role="note">
            Your Finance/Auditor access is read-only. Subscription changes, contributor administration, reserve management and payroll recovery remain with the workspace administrator.
          </p>
          <div className="workspace-quick-links__grid">
            <Link className="workspace-quick-link" href={`/workspace/${workspaceId}/payroll`}>
              <span><strong>Payroll history</strong><small>Review payroll runs, allocations and their recorded states.</small></span>
              <span aria-hidden="true" className="workspace-quick-link__arrow">→</span>
            </Link>
            <Link className="workspace-quick-link" href={`/workspace/${workspaceId}/contributors`}>
              <span><strong>Contributor directory</strong><small>Review contributor roles, wallet associations and onboarding status.</small></span>
              <span aria-hidden="true" className="workspace-quick-link__arrow">→</span>
            </Link>
            <Link className="workspace-quick-link" href={`/workspace/${workspaceId}/ledger`}>
              <span><strong>Workspace ledger</strong><small>Filter and export finalized financial and operational records.</small></span>
              <span aria-hidden="true" className="workspace-quick-link__arrow">→</span>
            </Link>
            <Link className="workspace-quick-link" href={`/workspace/${workspaceId}/billing`}>
              <span><strong>Billing history</strong><small>Review subscription status and verified payments.</small></span>
              <span aria-hidden="true" className="workspace-quick-link__arrow">→</span>
            </Link>
            <Link className="workspace-quick-link" href={`/workspace/${workspaceId}/gas-tank`}>
              <span><strong>Gas Tank activity</strong><small>Inspect the sponsored-fee balance and operation history.</small></span>
              <span aria-hidden="true" className="workspace-quick-link__arrow">→</span>
            </Link>
            <Link className="workspace-quick-link" href={`/workspace/${workspaceId}/notifications`}>
              <span><strong>Notifications</strong><small>Review workspace updates and operational notices.</small></span>
              <span aria-hidden="true" className="workspace-quick-link__arrow">→</span>
            </Link>
          </div>
        </section>
      ) : null}

      {workspace.role === "contributor" ? (
        <section className="workspace-quick-links" aria-labelledby="contributor-overview-heading">
          <header className="workspace-section-heading">
            <div>
              <p className="eyebrow">Contributor workspace</p>
              <h2 id="contributor-overview-heading">Your payroll</h2>
              <p>Review compensation assigned to your authenticated wallet and manage your contributor-controlled confidential account.</p>
            </div>
          </header>
          <div className="workspace-quick-links__grid">
            <Link className="workspace-quick-link" href={`/workspace/${workspaceId}/compensation`}>
              <span><strong>Your compensation</strong><small>Review payroll allocations, claim status and confidential balances.</small></span>
              <span aria-hidden="true" className="workspace-quick-link__arrow">→</span>
            </Link>
            <Link className="workspace-quick-link" href={`/workspace/${workspaceId}/notifications`}>
              <span><strong>Your notifications</strong><small>Read workspace updates and notices addressed to your account.</small></span>
              <span aria-hidden="true" className="workspace-quick-link__arrow">→</span>
            </Link>
          </div>
        </section>
      ) : null}

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
      <WorkspaceLegalFooter />
    </div>
  );
}