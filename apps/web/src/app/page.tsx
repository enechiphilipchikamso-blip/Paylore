import Image from "next/image";
import Link from "next/link";
import { createPublicMetadata } from "./site";

export const metadata = createPublicMetadata({
  title: "Private on-chain payroll",
  description:
    "Pay contributors in USDC on Solana while keeping compensation amounts confidential within the private payroll system.",
  path: "/"
});

export default function Home() {
  return (
    <>
      <section className="site-container hero">
        <div className="hero__copy">
          <p className="eyebrow">Private payroll for on-chain teams</p>

          <h1>Private compensation, built for on-chain organizations.</h1>

          <p className="hero__lede">
            Pay contributors in USDC on Solana while keeping
            compensation amounts confidential within the private
            payroll system.
          </p>

          <div className="hero__actions">
            <Link className="button" href="/product">
              Explore the product
            </Link>
            <Link
              className="button button--secondary"
              href="/pricing"
            >
              View pricing
            </Link>
          </div>
        </div>

        <div className="hero__visual" aria-hidden="true">
          <div className="hero-panel">
            <div className="hero-panel__mark">
              <Image
                src="/brand/paylore.svg"
                alt=""
                width={112}
                height={112}
                loading="eager"
                unoptimized
              />
            </div>

            <p className="hero-panel__title">
              Defined privacy and ownership boundaries
            </p>

            <p className="hero-panel__copy">
              Unclaimed payroll remains under organization
              control. Successful contributor claims move ownership
              to the contributor-controlled side of the system.
            </p>
          </div>
        </div>
      </section>

      <section className="site-container section">
        <div className="section-heading">
          <h2>Privacy without hiding the operating model</h2>
          <p className="section-heading__copy">
            Paylore focuses on confidential compensation and clear
            organization controls rather than anonymous or
            untraceable transfers.
          </p>
        </div>

        <div className="card-grid">
          <article className="card">
            <span className="card__number">01</span>
            <h3>USDC payroll</h3>
            <p>
              The MVP uses USDC as its payroll asset on Solana.
            </p>
          </article>

          <article className="card">
            <span className="card__number">02</span>
            <h3>Confidential amounts</h3>
            <p>
              Compensation amounts stay confidential within the
              confidential payroll system.
            </p>
          </article>

          <article className="card">
            <span className="card__number">03</span>
            <h3>Defined ownership</h3>
            <p>
              Organization recovery ends at successful contributor
              claim rather than extending into claimed contributor
              assets.
            </p>
          </article>
        </div>
      </section>

      <section className="site-container section">
        <div className="surface-card">
          <div className="surface-card__header">
            <h2>How the public product model works</h2>
            <p>
              Batch 02 presents the product model without requiring a
              wallet, account, or workspace state.
            </p>
          </div>

          <div className="steps">
            <div className="step">
              <div className="step__body">
                <h3>Fund the payroll reserve</h3>
                <p>
                  Organizations prepare their private payroll
                  operations from an organization-controlled reserve.
                </p>
              </div>
            </div>

            <div className="step">
              <div className="step__body">
                <h3>Prepare contributor compensation</h3>
                <p>
                  Payroll records define the compensation that each
                  contributor is entitled to receive.
                </p>
              </div>
            </div>

            <div className="step">
              <div className="step__body">
                <h3>Contributor claim and ownership</h3>
                <p>
                  A successful claim moves the relevant ownership
                  boundary to the contributor side of the system.
                </p>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section className="site-container section">
        <div className="notice">
          Paylore is not a mixer or general-purpose anonymity system.
          The public experience describes private compensation with
          explicit operational and ownership boundaries.
        </div>
      </section>
    </>
  );
}