import Image from "next/image";
import Link from "next/link";
import { createPublicMetadata } from "./site";

export const metadata = createPublicMetadata({
  title: "Private on-chain payroll",
  description:
    "Pay contributors in USDC with confidential compensation, clear organization controls, and contributor ownership boundaries.",
  path: "/"
});

export default function Home() {
  return (
    <>
      <section className="site-container hero">
        <div className="hero__copy">
          <p className="eyebrow">PRIVATE ON-CHAIN PAYROLL</p>
          <h1>Private on-chain payroll for crypto-native organizations.</h1>
          <p className="hero__lede">
            Pay contributors in USDC while compensation amounts remain
            confidential within Paylore’s payroll system, with clear
            organization controls and contributor ownership.
          </p>
          <div className="hero__actions">
            <Link className="button" href="/auth">
              Get started
            </Link>
            <Link className="button button--secondary" href="/product">
              Explore Paylore
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
            <p className="hero-panel__title">Clear controls. Private compensation.</p>
            <p className="hero-panel__copy">
              Unclaimed payroll remains under organization control. After a
              successful claim, compensation belongs to the contributor.
            </p>
          </div>
        </div>
      </section>

      <section className="site-container section">
        <div className="section-heading">
          <h2>Payroll without ordinary public salary balances</h2>
          <p className="section-heading__copy">
            Payroll should work for the people who run it without turning
            compensation into ordinary public token balances. Paylore combines
            wallet authentication, workspace controls, contributor onboarding,
            confidential payroll infrastructure, and organization-scoped
            operational records in one product.
          </p>
        </div>

        <div className="card-grid">
          <article className="card">
            <span className="card__number">01</span>
            <h3>Confidential compensation</h3>
            <p>
              Paylore is designed to keep compensation amounts confidential
              while they remain within the confidential payroll system. Public
              blockchain activity can still reveal information outside
              Paylore’s control, so Paylore does not promise anonymity or
              untraceability.
            </p>
          </article>
          <article className="card">
            <span className="card__number">02</span>
            <h3>Organization controls</h3>
            <p>
              Workspaces define access, contributor relationships, subscription
              state, reserve custody, and operational boundaries. Roles clarify
              who administers the workspace, who has finance and audit access,
              and who receives compensation.
            </p>
          </article>
          <article className="card">
            <span className="card__number">03</span>
            <h3>Contributor ownership</h3>
            <p>
              Before a successful claim, the organization follows the
              pre-claim recovery rules. After a successful contributor claim,
              organization recovery authority ends for that compensation.
            </p>
          </article>
        </div>
      </section>

      <section className="site-container section">
        <div className="surface-card">
          <div className="surface-card__header">
            <h2>USDC on Solana</h2>
            <p>
              Paylore uses USDC for payroll and workspace payments, with
              confidential payroll infrastructure built around Solana and
              Token-2022.
            </p>
          </div>
          <div className="prose">
            <h3>How it works</h3>
            <ol className="numbered-list">
              <li>Connect a supported wallet.</li>
              <li>Sign in to Paylore.</li>
              <li>Create or choose a workspace.</li>
              <li>Activate the workspace subscription.</li>
              <li>Add and onboard contributors.</li>
              <li>Run payroll through the payroll workflows.</li>
            </ol>
            <h3>Security</h3>
            <p>
              Authentication, authorization, reserve custody, provider
              credentials, and other privileged operations are enforced on the
              server. Sensitive cryptographic material is not delivered to the
              browser.
            </p>
          </div>
          <div className="hero__actions">
            <Link className="button button--secondary" href="/security">
              Read the Security overview
            </Link>
          </div>
        </div>
      </section>
    </>
  );
}
