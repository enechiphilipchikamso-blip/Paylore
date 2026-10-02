import { PublicPage } from "../../components/public/PublicPage";
import { createPublicMetadata } from "../site";

export const metadata = createPublicMetadata({
  title: "Terms",
  description:
    "Public Paylore terms information shell.",
  path: "/terms"
});

export default function TermsPage() {
  return (
    <PublicPage
      eyebrow="Legal"
      title="Terms"
      description="Public terms information shell for Paylore."
    >
      <section className="surface-card">
        <div className="prose">
          <p>
            This page establishes the public terms information
            structure for the product.
          </p>

          <p>
            Final legal and contractual wording is maintained as a
            separate content/legal responsibility. This Batch 02
            implementation does not invent binding contractual
            commitments.
          </p>
        </div>
      </section>
    </PublicPage>
  );
}