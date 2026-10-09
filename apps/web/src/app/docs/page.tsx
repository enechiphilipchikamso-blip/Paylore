import Link from "next/link";
import { PublicPage } from "../../components/public/PublicPage";
import { createPublicMetadata } from "../site";

export const metadata = createPublicMetadata({
  title: "Documentation",
  description:
    "Learn how Paylore workspaces, authentication, billing, contributor onboarding, and confidential payroll fit together.",
  path: "/docs"
});

export default function DocsPage() {
  return (
    <PublicPage
      eyebrow="DOCUMENTATION"
      title="Understand Paylore before you use it."
      description="This documentation explains the product model, workspace behavior, authentication, contributor onboarding, subscriptions, confidential payroll, and operational boundaries in product language."
    >
      <section className="card-grid">
        <article className="card">
          <h2>Start here</h2>
          <p>
            Learn how workspaces, wallet authentication, subscriptions,
            contributors, and confidential payroll fit together.
          </p>
          <Link href="/product">Read the product overview</Link>
        </article>
        <article className="card">
          <h2>Workspace identity and access</h2>
          <p>
            Workspace identity is based on unique internal workspace IDs and
            membership records. Workspace names are labels and do not need to
            be unique.
          </p>
        </article>
        <article className="card">
          <h2>Wallet connection and sign-in</h2>
          <p>
            Paylore separates wallet connection from authentication. Connect a
            supported wallet, then sign the Paylore authentication request to
            establish your session.
          </p>
        </article>
        <article className="card">
          <h2>Workspace billing</h2>
          <p>
            The Paylore Workspace plan is $49/month in USDC. Creating a
            workspace does not activate billing. Renewal is manual and expired
            workspaces enter Read-Only Archive Mode.
          </p>
        </article>
        <article className="card">
          <h2>Contributor onboarding</h2>
          <p>
            Organizations can maintain contributor records, import CSV/XLSX
            files, validate Solana addresses, detect duplicate wallets, and
            issue workspace-specific invitation links.
          </p>
        </article>
        <article className="card">
          <h2>Confidential compensation</h2>
          <p>
            Paylore is designed to keep compensation amounts confidential
            within its payroll system. Successful claims establish contributor
            ownership according to the product rules.
          </p>
        </article>
      </section>

      <section className="surface-card">
        <div className="surface-card__header">
          <h2>Security</h2>
          <p>
            Privileged authorization, session management, reserve key custody,
            and provider credentials are server-side responsibilities.
            Sensitive secrets are not delivered to the browser.
          </p>
        </div>
        <div className="prose">
          <p>
            These pages describe the current product behavior and controls
            without exposing private workspace data.
          </p>
          <Link href="/security">Read the Security overview</Link>
        </div>
      </section>
    </PublicPage>
  );
}
