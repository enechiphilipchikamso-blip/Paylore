import { PublicPage } from "../../components/public/PublicPage";
import { createPublicMetadata } from "../site";

export const metadata = createPublicMetadata({
  title: "Privacy",
  description:
    "Public Paylore privacy information shell.",
  path: "/privacy"
});

export default function PrivacyPage() {
  return (
    <PublicPage
      eyebrow="Legal"
      title="Privacy"
      description="Public privacy information shell for Paylore."
    >
      <section className="surface-card">
        <div className="prose">
          <p>
            This page establishes the public privacy information
            structure for the product.
          </p>

          <p>
            Public pages are separate from authenticated application
            state and do not render private workspace data.
          </p>

          <p>
            Final legal/privacy wording remains a content and legal
            responsibility outside this implementation slice.
          </p>
        </div>
      </section>
    </PublicPage>
  );
}