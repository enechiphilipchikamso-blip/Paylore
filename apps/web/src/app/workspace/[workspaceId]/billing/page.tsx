import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import {
  getWorkspaceForUser,
  getWorkspaceSubscription,
  listSubscriptionPayments
} from "@paylore/database";
import { BillingActions } from "../../../../components/workspace/BillingActions";
import {
  WorkspaceLegalFooter,
  WorkspaceNavigation
} from "../../../../components/workspace/WorkspaceNavigation";
import { getDatabase } from "../../../../server/db";
import { getSessionState } from "../../../../server/session";
import { loadPayloreConfig } from "../../../../server/config";
import { isValidSolanaAddress } from "../../../../server/security";

export const metadata: Metadata = {
  title: "Workspace billing",
  robots: { index: false, follow: false }
};

export const dynamic = "force-dynamic";

export default async function WorkspaceBillingPage({
  params
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const session = await getSessionState();

  if (session.status !== "authenticated") {
    const reason =
      session.status === "inactivity_expired"
        ? "inactivity-expired"
        : session.status === "hard_expired"
          ? "hard-expired"
          : undefined;
    redirect(
      `/auth${reason ? `?reason=${reason}&` : "?"}next=${encodeURIComponent(`/workspace/${workspaceId}/billing`)}`
    );
  }

  const db = getDatabase();
  const workspace = await getWorkspaceForUser(
    db,
    session.session.userId,
    workspaceId
  );
  if (!workspace) {
    notFound();
  }
  if (workspace.role === "contributor") {
    notFound();
  }

  const [subscription, payments] = await Promise.all([
    getWorkspaceSubscription(db, workspaceId),
    listSubscriptionPayments(db, workspaceId)
  ]);

  const status = subscription?.status ?? "inactive";
  const config = loadPayloreConfig();
  const paymentRecipient =
    config.PAYLORE_SUBSCRIPTION_RECIPIENT &&
    isValidSolanaAddress(config.PAYLORE_SUBSCRIPTION_RECIPIENT)
      ? config.PAYLORE_SUBSCRIPTION_RECIPIENT
      : null;
  const paymentMint =
    config.PAYLORE_SUBSCRIPTION_USDC_MINT &&
    isValidSolanaAddress(config.PAYLORE_SUBSCRIPTION_USDC_MINT)
      ? config.PAYLORE_SUBSCRIPTION_USDC_MINT
      : null;
  const statusLabel = {
    inactive: "Inactive",
    active: "Active",
    cancel_scheduled: "Cancellation scheduled",
    archived: "Read-Only Archive"
  }[status];

  return (
    <main className="protected-wrap workspace-page">
      <WorkspaceNavigation
        workspaceId={workspaceId}
        workspaceName={workspace.workspaceName}
        role={workspace.role}
      />
      <header className="protected-header">
        <p className="eyebrow">Billing</p>
        <h2>Workspace billing</h2>
        <p>Each workspace has its own subscription state and payment history.</p>
      </header>
      <section className="surface-card billing-card">
        <div className="billing-card__summary">
          <div>
            <h3>Paylore Workspace</h3>
            <p>
              <span className="financial-value">$49</span> / month · Paid in
              USDC · Manual renewal
            </p>
          </div>
          <p className={`subscription-status subscription-status--${status}`}>
            {statusLabel}
          </p>
        </div>
        <p className="notice">
          Read-Only Archive begins after the paid period ends if the
          subscription is not renewed. Qualifying existing claims and
          obligations remain available according to the product rules.
        </p>
        <BillingActions
          workspaceId={workspaceId}
          walletAddress={session.session.walletAddress}
          paymentRecipient={paymentRecipient}
          paymentMint={paymentMint}
          status={status}
          periodStart={subscription?.periodStart?.toISOString() ?? null}
          periodEnd={subscription?.periodEnd?.toISOString() ?? null}
          cancelAtPeriodEnd={subscription?.cancelAtPeriodEnd ?? false}
          canManage={workspace.role === "organization_admin"}
          payments={payments.map((payment) => ({
            ...payment,
            periodStart: payment.periodStart.toISOString(),
            periodEnd: payment.periodEnd.toISOString(),
            verifiedAt: payment.verifiedAt.toISOString()
          }))}
        />
      </section>
      <WorkspaceLegalFooter />
    </main>
  );
}
