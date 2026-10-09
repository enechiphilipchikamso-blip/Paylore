import { PublicPage } from "../../components/public/PublicPage";
import { createPublicMetadata } from "../site";

export const metadata = createPublicMetadata({
  title: "Security",
  description:
    "How Paylore separates public presentation, authenticated access, privileged systems, and confidential reserve custody.",
  path: "/security"
});

export default function SecurityPage() {
  return (
    <PublicPage
      eyebrow="SECURITY"
      title="Security is part of how Paylore works."
      description="Paylore separates public presentation, authenticated access, application persistence, Solana integrations, and confidential key custody so privileged operations remain behind explicit server-side boundaries."
    >
      <section className="surface-card prose">
        <h2>Authentication</h2>
        <p>
          Paylore uses wallet-based authentication with a server-issued
          challenge. A wallet connection alone is not an authenticated
          session.
        </p>
        <h2>Authorization</h2>
        <p>
          Workspace authorization is evaluated server-side using user
          identity, workspace membership, role, and operation-specific
          permissions.
        </p>
        <h2>Sessions</h2>
        <p>
          Sessions use server-managed cookies. The inactivity limit is 12
          hours. The maximum session lifetime is 7 days and requires a fresh
          login.
        </p>
        <h2>Secret handling</h2>
        <p>
          Reserve private keys, envelope secrets, provider API keys, database
          credentials, deployment secrets, and session secrets are not
          delivered to browser code.
        </p>
        <h2>Confidential reserve</h2>
        <p>
          Each workspace has its own confidential payroll reserve. Private-key
          material is encrypted at rest and accessed through a server-only
          runtime boundary.
        </p>
        <h2>Provider security</h2>
        <p>
          Paylore uses Helius as its primary RPC/webhook provider and QuickNode
          as its secondary provider. Provider credentials remain server-side.
        </p>
        <h2>Blockchain boundary</h2>
        <p>
          Paylore uses Solana, Token-2022, official Token Wrap infrastructure,
          and the Paylore Payroll Program. Blockchain activity remains subject
          to the visibility of the underlying network.
        </p>
        <h2>Privacy boundary</h2>
        <p>
          Paylore provides compensation-amount confidentiality and reduced
          obvious linkage inside its payroll system. It does not promise
          anonymity or untraceability.
        </p>
        <h2>Error handling</h2>
        <p>
          User-facing errors do not expose stack traces, cryptographic
          secrets, session tokens, or provider diagnostics.
        </p>
        <p>
          <a href="/terms">Terms</a> · <a href="/privacy">Privacy</a>
        </p>
      </section>
    </PublicPage>
  );
}
