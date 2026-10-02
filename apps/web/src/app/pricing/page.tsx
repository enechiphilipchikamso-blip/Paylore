import Link from "next/link";
import { PublicPage } from "../../components/public/PublicPage";
import { createPublicMetadata } from "../site";

export const metadata = createPublicMetadata({
  title: "Pricing",
  description:
    "Paylore Workspace is the approved $49/month USDC-paid workspace plan.",
  path: "/pricing"
});

export default function PricingPage() {
  return (
    <PublicPage
      eyebrow="Pricing"
      title="One workspace plan"
      description="Simple pricing for the Paylore MVP."
    >
      <section className="surface-card price-card">
        <div>
          <p className="eyebrow">Paylore Workspace</p>

          <div className="price-card__price">
            <span className="price-card__amount">$49</span>
            <span className="price-card__period">/ month</span>
          </div>
        </div>

        <div className="price-card__facts">
          <div className="price-card__fact">
            <span>Payment basis</span>
            <strong>USDC</strong>
          </div>

          <div className="price-card__fact">
            <span>Plan model</span>
            <strong>One paid workspace plan</strong>
          </div>

          <div className="price-card__fact">
            <span>Workspace subscription</span>
            <strong>Independently subscribed</strong>
          </div>
        </div>

        <div className="notice">
          This page is informational. Subscription activation and
          renewal logic are not implemented as part of the public
          experience foundation.
        </div>

        <div className="hero__actions">
          <Link className="button" href="/product">
            Explore the product
          </Link>
        </div>
      </section>
    </PublicPage>
  );
}