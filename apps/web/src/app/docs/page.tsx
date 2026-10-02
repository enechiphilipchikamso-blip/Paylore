import Link from "next/link";
import { PublicPage } from "../../components/public/PublicPage";
import { createPublicMetadata } from "../site";

export const metadata = createPublicMetadata({
  title: "Documentation",
  description:
    "Public Paylore documentation foundation covering the product model, security posture, and public boundaries.",
  path: "/docs"
});

export default function DocsPage() {
  return (
    <PublicPage
      eyebrow="Documentation"
      title="Public documentation"
      description="The public documentation foundation establishes the information architecture for Paylore."
    >
      <section className="card-grid">
        <article className="card">
          <h2>Product model</h2>
          <p>
            Understand private on-chain payroll, USDC compensation,
            and defined ownership boundaries.
          </p>
          <Link href="/product">Read the product overview</Link>
        </article>

        <article className="card">
          <h2>Security posture</h2>
          <p>
            Review the public-facing security architecture and the
            separation between public presentation and privileged
            systems.
          </p>
          <Link href="/security">Read the security page</Link>
        </article>

        <article className="card">
          <h2>Public policies</h2>
          <p>
            Access the public terms and privacy shells.
          </p>
          <div className="hero__actions">
            <Link href="/terms">Terms</Link>
            <Link href="/privacy">Privacy</Link>
          </div>
        </article>
      </section>

      <section className="surface-card">
        <div className="surface-card__header">
          <h2>Documentation foundation</h2>
        </div>

        <div className="prose">
          <p>
            This route establishes the public documentation
            information architecture. Detailed technical and
            operational documentation expands as the corresponding
            product capabilities are implemented.
          </p>

          <p>
            This public documentation layer does not expose private
            application data, authentication state, wallet state, or
            privileged configuration.
          </p>
        </div>
      </section>
    </PublicPage>
  );
}