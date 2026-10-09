import { PublicPage } from "../../components/public/PublicPage";
import { createPublicMetadata } from "../site";

const sections = [
  {
    title: "1. Information we use",
    text: "Depending on the features you use, Paylore may process wallet public addresses and wallet identity information; authentication and session information; workspace and membership information; contributor profile and onboarding information; subscription and billing transaction references; application activity and operational records; blockchain transaction metadata relevant to product operations; and security and diagnostic information needed to protect the service."
  },
  {
    title: "2. Wallet information",
    text: "A wallet public address is used to identify the wallet participating in an authentication or blockchain workflow. Paylore does not ask you to provide a wallet seed phrase or private key."
  },
  {
    title: "3. Workspace information",
    text: "Workspace data is scoped to the workspace and is used to provide the organization features you access, including roles, contributors, subscriptions, and operational state."
  },
  {
    title: "4. Contributor information",
    text: "Contributor information may include display name, identity wallet, effective payout address, onboarding state, and workspace-local administrative labels or notes. Raw uploaded contributor spreadsheets are not retained by default unless the product explicitly requires retention for a later feature."
  },
  {
    title: "5. Payment and blockchain information",
    text: "Subscription payments and applicable product operations may produce public blockchain records, transaction signatures, and other network metadata. Paylore cannot delete blockchain state from the underlying network."
  },
  {
    title: "6. Service providers",
    text: "Paylore may use infrastructure providers for hosting, databases, RPC access, blockchain webhooks, deployment, monitoring, and related service functions. Provider credentials remain protected server-side."
  },
  {
    title: "7. Security",
    text: "Paylore uses server-side authorization, secure session handling, encrypted confidential reserve material, and access controls designed to prevent unauthorized access."
  },
  {
    title: "8. Retention and deletion",
    text: "Application data is retained according to the product lifecycle and applicable requirements. Some workspaces may become eligible for deletion after a defined inactive period when no qualifying obligations remain. A user-initiated workspace deletion request includes a 72-hour pending period under the product rules. Blockchain data cannot be deleted by Paylore."
  },
  {
    title: "9. Privacy requests",
    text: "Privacy requests may be submitted using the official privacy contact published by Paylore. Paylore may request information reasonably necessary to verify the request and will handle applicable requests according to applicable law."
  },
  {
    title: "10. Jurisdiction and transfers",
    text: "Any jurisdiction, international-transfer, controller/processor, and regulatory disclosures applicable to the service are stated in the version of this policy that applies to the relevant user or organization."
  },
  {
    title: "11. Privacy contact",
    text: "Privacy inquiries should be submitted using the official privacy contact information published by Paylore."
  }
];

const intro =
  "Paylore is designed to process the information required to provide wallet authentication, workspace access, subscriptions, contributor onboarding, and payroll operations while keeping compensation amounts confidential within the payroll system.";

export const metadata = createPublicMetadata({
  title: "Privacy at Paylore",
  description: intro,
  path: "/privacy"
});

export default function PrivacyPage() {
  return (
    <PublicPage
      eyebrow="PRIVACY"
      title="Privacy at Paylore"
      description={intro}
    >
      <article className="surface-card prose legal-copy">
        {sections.map((section) => (
          <section key={section.title}>
            <h2>{section.title}</h2>
            <p>{section.text}</p>
          </section>
        ))}
        <p>
          <a href="/terms">Terms</a> · <a href="/security">Security</a>
        </p>
      </article>
    </PublicPage>
  );
}
