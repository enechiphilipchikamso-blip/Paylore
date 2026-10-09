import { PublicPage } from "../../components/public/PublicPage";
import { createPublicMetadata } from "../site";

const terms = [
  {
    title: "1. Service",
    text: "Paylore provides software for crypto-native organizations to manage workspace access, contributors, subscriptions, and private on-chain payroll workflows. The service is provided through the Paylore application and related hosted interfaces."
  },
  {
    title: "2. Account and wallet access",
    text: "You are responsible for maintaining control of the wallet and account you use to access Paylore. Connecting a wallet does not by itself create an authenticated Paylore session. You must complete the required authentication flow to access protected product features."
  },
  {
    title: "3. Workspaces",
    text: "A workspace is an organization-specific environment within Paylore. Workspace membership, role, and authorization are evaluated within that workspace. Workspace names are not required to be unique."
  },
  {
    title: "4. Subscription",
    text: "The Paylore Workspace plan is $49 per month and is paid manually in USDC. Each workspace is subscribed independently. Creating a workspace does not activate billing. Renewal is manual. Cancellation takes effect at the end of the paid period."
  },
  {
    title: "5. Expiration and archive",
    text: "When a paid period expires, the workspace may enter Read-Only Archive Mode. Existing qualifying claims and obligations are not invalidated solely because the workspace subscription expires. Some workspace actions may be unavailable while the workspace is expired."
  },
  {
    title: "6. Blockchain transactions",
    text: "Some Paylore actions require blockchain transactions. Blockchain transactions are executed on the applicable Solana network and may require network fees. Blockchain transactions may be irreversible after confirmation. Paylore cannot reverse blockchain state that is already confirmed on-chain."
  },
  {
    title: "7. User authority and ownership",
    text: "Users are responsible for the approvals and wallet signatures they provide. Paylore does not take custody of a user's general-purpose wallet private keys."
  },
  {
    title: "8. Confidential payroll",
    text: "Paylore is designed to keep compensation amounts confidential within its payroll system. This does not mean that blockchain activity is anonymous or untraceable. Public blockchain information and other information outside Paylore's control may permit inference or correlation."
  },
  {
    title: "9. Contributor ownership",
    text: "When a contributor successfully claims compensation into a contributor-controlled confidential account, organization recovery authority ends according to the Paylore product rules."
  },
  {
    title: "10. Acceptable use",
    text: "You must not use Paylore to violate applicable law, attempt unauthorized access, interfere with service availability, bypass workspace authorization, abuse data-import or invitation mechanisms, or attempt to obtain another user's credentials or private account information."
  },
  {
    title: "11. Security and credentials",
    text: "Do not share wallet private keys, seed phrases, API keys, session tokens, or other credentials with Paylore support or through the Paylore interface."
  },
  {
    title: "12. Availability and changes",
    text: "Paylore may change, improve, suspend, or discontinue product functionality subject to the applicable agreement and law. Blockchain networks, providers, wallets, and third-party services may also change independently of Paylore."
  },
  {
    title: "13. No anonymity guarantee",
    text: "Paylore does not provide general-purpose anonymous or untraceable transfer functionality and does not guarantee that blockchain activity cannot be linked or inferred."
  },
  {
    title: "14. No financial, tax, employment, or legal advice",
    text: "Paylore is software infrastructure. It does not provide financial, tax, employment, payroll-compliance, or legal advice."
  },
  {
    title: "15. Governing law and disputes",
    text: "Applicable governing-law, dispute-resolution, liability, warranty, and other contractual provisions are governed by the agreement applicable to the service and by applicable law."
  },
  {
    title: "16. Legal contact",
    text: "Legal notices should be sent using the official legal contact information published by Paylore for the applicable service."
  }
];

export const metadata = createPublicMetadata({
  title: "Terms of Service",
  description:
    "Planning-authored product-aligned Terms of Service draft for Paylore. Final production publication requires user/legal approval.",
  path: "/terms"
});

export default function TermsPage() {
  return (
    <PublicPage
      eyebrow="TERMS"
      title="Terms of Service"
      description="Planning-authored product-aligned draft. Final production publication requires user/legal approval."
    >
      <article className="surface-card prose legal-copy">
        <p className="legal-copy__effective">
          Effective date: [USER APPROVAL DATE]
        </p>
        {terms.map((section) => (
          <section key={section.title}>
            <h2>{section.title}</h2>
            <p>{section.text}</p>
          </section>
        ))}
        <p>
          <a href="/privacy">Privacy</a> · <a href="/security">Security</a>
        </p>
      </article>
    </PublicPage>
  );
}
