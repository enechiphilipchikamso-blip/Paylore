import { PublicPage } from "../../components/public/PublicPage";
import { createPublicMetadata } from "../site";

export const metadata = createPublicMetadata({
  title: "Security",
  description:
    "Public Paylore security posture covering server-side boundaries, workspace isolation, and separation from privileged systems.",
  path: "/security"
});

export default function SecurityPage() {
  return (
    <PublicPage
      eyebrow="Security"
      title="Security posture"
      description="The public experience is designed around separation between public presentation and privileged application systems."
    >
      <section className="card-grid">
        <article className="card">
          <h2>Server-side boundaries</h2>
          <p>
            Privileged configuration, authorization, and domain
            orchestration remain outside public page rendering.
          </p>
        </article>

        <article className="card">
          <h2>Workspace isolation</h2>
          <p>
            Workspace state is isolated by application identity and
            membership relationships rather than by public display
            names.
          </p>
        </article>

        <article className="card">
          <h2>Public-page isolation</h2>
          <p>
            Public pages do not query future authenticated endpoints,
            wallet state, payroll state, reserve keys, or Gas Tank
            credentials.
          </p>
        </article>
      </section>

      <section className="surface-card">
        <div className="surface-card__header">
          <h2>What is intentionally not public</h2>
        </div>

        <div className="prose">
          <ul>
            <li>Database connection strings</li>
            <li>Private keys and reserve keys</li>
            <li>Gas Tank credentials</li>
            <li>RPC provider secrets</li>
            <li>Private cryptographic material</li>
            <li>Internal authorization state</li>
          </ul>

          <p>
            These public pages describe the architecture without
            exposing privileged application state or claiming
            unsupported guarantees.
          </p>
        </div>
      </section>
    </PublicPage>
  );
}