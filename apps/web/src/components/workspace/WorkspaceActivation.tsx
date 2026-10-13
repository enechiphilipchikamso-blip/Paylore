"use client";

import Link from "next/link";
import { useState } from "react";
import { SubscriptionPaymentAction } from "./SubscriptionPaymentAction";

export function WorkspaceActivation({
  workspaceId,
  workspaceName,
  walletAddress,
  role,
  paymentConfigured
}: {
  workspaceId: string;
  workspaceName: string;
  walletAddress: string;
  role: "organization_admin" | "contributor" | "finance_auditor";
  paymentConfigured: boolean;
}) {
  const [activated, setActivated] = useState(false);
  const [paid, setPaid] = useState(false);
  const truncatedWallet = `${walletAddress.slice(0, 5)}…${walletAddress.slice(-4)}`;

  return (
    <main className="workspace-lock">
      <div aria-hidden="true" className="workspace-lock__underlay" inert>
        <header className="workspace-lock__underlay-header">
          <span>Paylore</span>
          <span>{truncatedWallet}</span>
        </header>
        <nav aria-hidden="true" className="workspace-lock__underlay-nav">
          <span>Home</span>
          <span>Contributor Directory</span>
          <span>Invitations</span>
          <span>Settings</span>
        </nav>
        <section className="workspace-lock__underlay-content">
          <p className="eyebrow">Workspace</p>
          <h1>{workspaceName}</h1>
          <div className="workspace-lock__placeholder" />
          <div className="workspace-lock__placeholder workspace-lock__placeholder--short" />
        </section>
      </div>

      <div className="workspace-lock__scrim" />
      <header className="workspace-lock__wallet">
        <span>Connected wallet</span>
        <code title={walletAddress}>{truncatedWallet}</code>
      </header>

      <section
        aria-labelledby="workspace-lock-heading"
        aria-modal="true"
        className="workspace-lock__dialog"
        role="dialog"
      >
        {!activated ? (
          <>
            <p className="eyebrow">Paylore Workspace</p>
            <h1 id="workspace-lock-heading">
              {workspaceName} is locked
            </h1>
            <p>
              Create the workspace now and activate it with a one-time wallet
              payment. Creating a workspace does not activate billing.
            </p>
            <div className="workspace-lock__plan">
              <strong className="financial-value">$49 / month</strong>
              <span>USDC on Solana Devnet</span>
              <span>Manual renewal · no automatic charges</span>
            </div>
            {role === "organization_admin" ? (
              <>
                <SubscriptionPaymentAction
                  actionLabel="Get started"
                  configured={paymentConfigured}
                  refreshOnSuccess={false}
                  onSuccess={() => {
                    setPaid(true);
                    setActivated(true);
                  }}
                  walletAddress={walletAddress}
                  workspaceId={workspaceId}
                />
                {!paymentConfigured ? (
                  <div className="state-callout" data-state="partial" role="status">
                    <span className="state-callout__signal" aria-hidden="true" />
                    <p>Payment setup is incomplete. The approved subscription recipient and Devnet USDC mint must be configured before activation.</p>
                  </div>
                ) : null}
              </>
            ) : (
              <div className="state-callout" data-state="partial" role="status">
                <span className="state-callout__signal" aria-hidden="true" />
                <p>Only the Organization Administrator can activate billing. Ask them to continue.</p>
              </div>
            )}
            <p className="workspace-lock__legal">
              By continuing, you authorize one $49 USDC payment for this paid
              period. Future renewals require a separate payment.
            </p>
          </>
        ) : (
          <>
            <div className="state-callout" data-state="success" role="status">
              <span className="state-callout__signal" aria-hidden="true" />
              <p>Payment verified. Your workspace is active.</p>
            </div>
            <h1 id="workspace-lock-heading">
              {paid ? "Workspace activated" : "Workspace active"}
            </h1>
            <p>The payment is verified and this workspace is ready to enter.</p>
            <Link className="button" href={`/workspace/${workspaceId}?activated=1`}>
              Enter the Activated Workspace — {workspaceName}
            </Link>
          </>
        )}
        <Link className="workspace-lock__back" href="/app">
          Back to all workspaces
        </Link>
        <footer className="workspace-legal-footer">
          <Link href="/terms">Terms</Link>
          <Link href="/privacy">Privacy</Link>
          <Link href="/security">Security</Link>
        </footer>
      </section>
    </main>
  );
}
