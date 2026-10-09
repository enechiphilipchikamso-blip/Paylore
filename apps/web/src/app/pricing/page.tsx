import Link from "next/link";
import { PublicPage } from "../../components/public/PublicPage";
import { createPublicMetadata } from "../site";

export const metadata = createPublicMetadata({
  title: "Pricing",
  description:
    "Paylore Workspace is $49 per month, paid manually in USDC with renewal controlled by each workspace.",
  path: "/pricing"
});

export default function PricingPage() {
  return (
    <PublicPage
      eyebrow="PAYLORE WORKSPACE"
      title="Paylore Workspace"
      description="One workspace, one clear plan, manual USDC renewal, and the operational controls required for private on-chain payroll."
    >
      <section className="surface-card price-card">
        <div>
          <p className="eyebrow">Paylore Workspace</p>
          <div className="price-card__price">
            <span className="price-card__amount">$49</span>
            <span className="price-card__period">/ month</span>
          </div>
        </div>

        <p className="notice">
          Creating a workspace does not activate billing.
        </p>

        <div>
          <h2>Included</h2>
          <ul className="feature-list">
            <li>Workspace administration</li>
            <li>Secure wallet authentication</li>
            <li>Contributor directory and onboarding</li>
            <li>Workspace-scoped roles</li>
            <li>Subscription and archive lifecycle</li>
            <li>Confidential payroll infrastructure</li>
            <li>Organization-scoped operational records</li>
          </ul>
        </div>

        <div className="prose">
          <h2>Billing model</h2>
          <p>
            Payment is made manually in USDC for the current paid period.
            Renewal is manual. Cancellation takes effect at the end of the
            paid period. There is no automatic wallet pull for future
            renewals.
          </p>
        </div>

        <div className="hero__actions">
          <Link className="button" href="/auth">
            Get started
          </Link>
          <Link className="button button--secondary" href="/product">
            Read the product overview
          </Link>
        </div>
      </section>
    </PublicPage>
  );
}
