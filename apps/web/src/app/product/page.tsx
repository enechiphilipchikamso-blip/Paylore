import Link from "next/link";
import { PublicPage } from "../../components/public/PublicPage";
import { createPublicMetadata } from "../site";

export const metadata = createPublicMetadata({
  title: "Product",
  description:
    "Learn how Paylore approaches private on-chain payroll, confidential compensation, USDC settlement, and defined ownership boundaries.",
  path: "/product"
});

export default function ProductPage() {
  return (
    <PublicPage
      eyebrow="Product"
      title="Private payroll on Solana"
      description="Paylore is a private on-chain payroll platform for crypto-native organizations."
    >
      <section className="card-grid">
        <article className="card">
          <h2>Confidential compensation</h2>
          <p>
            Paylore is designed to keep compensation amounts
            confidential while they remain within the confidential
            payroll system.
          </p>
        </article>

        <article className="card">
          <h2>USDC-only MVP</h2>
          <p>
            The MVP focuses on USDC payroll rather than introducing
            multiple payroll assets or arbitrary token wrapping.
          </p>
        </article>

        <article className="card">
          <h2>Defined recovery boundary</h2>
          <p>
            Organization recovery applies before successful claim.
            Successful contributor claims establish the contributor
            ownership boundary.
          </p>
        </article>
      </section>

      <section className="surface-card">
        <div className="surface-card__header">
          <h2>What Paylore is not</h2>
        </div>

        <div className="prose">
          <p>
            Paylore is not intended to provide general-purpose
            anonymous or untraceable transfers, mixers, or exchange
            functionality.
          </p>

          <p>
            The public product experience therefore describes
            privacy in terms of confidential compensation and
            reduced obvious linkage rather than anonymity.
          </p>

          <p>
            Public pages do not require a wallet connection or
            authenticated session.
          </p>
        </div>
      </section>

      <section className="surface-card">
        <div className="surface-card__header">
          <h2>Continue exploring</h2>
        </div>

        <div className="hero__actions">
          <Link className="button" href="/pricing">
            View pricing
          </Link>
          <Link
            className="button button--secondary"
            href="/security"
          >
            Security posture
          </Link>
        </div>
      </section>
    </PublicPage>
  );
}