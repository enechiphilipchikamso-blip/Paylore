import Link from "next/link";
import { PublicPage } from "../../components/public/PublicPage";
import { createPublicMetadata } from "../site";

export const metadata = createPublicMetadata({
  title: "Product",
  description:
    "Explore Paylore workspaces, wallet authentication, subscriptions, contributor onboarding, and confidential USDC payroll.",
  path: "/product"
});

export default function ProductPage() {
  return (
    <PublicPage
      eyebrow="THE PAYLORE PRODUCT"
      title="Private payroll without giving up clear operational control."
      description="Paylore gives crypto-native organizations a structured way to manage USDC payroll while keeping compensation amounts confidential inside the payroll system."
    >
      <section className="content-stack">
        <article className="surface-card prose">
          <h2>Workspaces</h2>
          <p>
            Each workspace has its own identity, members, roles, subscription,
            operational state, and confidential reserve. A user can belong to
            multiple workspaces without merging organization data.
          </p>
          <h2>Authentication</h2>
          <p>
            Connect first. Authenticate second. Wallet connection identifies
            the wallet available to the browser. Paylore authentication
            requires a server-issued challenge and wallet signature. These
            states remain separate so users can see whether they are
            connected, authenticated, or signed out.
          </p>
          <h2>Subscriptions</h2>
          <p>
            The Paylore Workspace plan is $49/month and is paid manually in
            USDC. Each workspace is subscribed independently. Creating a
            workspace does not activate billing.
          </p>
          <h2>Contributors</h2>
          <p>
            Organizations can maintain workspace-local contributor records,
            import contributor data from CSV or XLSX, validate Solana
            addresses, detect duplicate wallets, and manage workspace-specific
            invitation links.
          </p>
          <h2>Confidential reserve</h2>
          <p>
            Each workspace has its own confidential payroll reserve. Reserve
            key material is generated and encrypted server-side, with strict
            isolation between organizations.
          </p>
          <h2>Solana foundation</h2>
          <p>
            Paylore uses provider-neutral Solana integration with Helius as the
            primary RPC/webhook provider and QuickNode as the secondary
            provider, together with official Token Wrap, Token-2022, and the
            Paylore Payroll Program foundation.
          </p>
          <h2>Ownership</h2>
          <p>
            Paylore keeps the pre-claim recovery boundary explicit and the
            post-claim contributor ownership boundary explicit. Claimed
            contributor compensation is not treated as an ordinary company
            balance.
          </p>
        </article>

        <section className="surface-card">
          <div className="surface-card__header">
            <h2>Explore Paylore</h2>
          </div>
          <div className="hero__actions">
            <Link className="button" href="/pricing">
              View pricing
            </Link>
            <Link className="button button--secondary" href="/security">
              Security overview
            </Link>
          </div>
        </section>
      </section>
    </PublicPage>
  );
}
