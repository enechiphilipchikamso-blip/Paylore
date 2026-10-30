import Link from "next/link";

export default function ContributorLeftWorkspacePage() {
  return (
    <div className="protected-wrap workspace-page">
      <section className="surface-card">
        <div className="state-callout" data-state="success" role="status">
          <span className="state-callout__signal" aria-hidden="true" />
          <p>You have left the workspace</p>
        </div>
        <h1>Workspace access has been removed.</h1>
        <p>
          Workspace access has been removed. Check your durable in-app notification for whether you closed the account during departure or left it open under your control. Refresh to return to the Paylore public portal.
        </p>
        <p className="notice">
          If your wallet remains connected, disconnect it using your wallet
          controls before continuing.
        </p>
        <p>
          <Link href="/notifications">Review your notifications</Link>
        </p>
        <Link className="button" href="/">
          Return to Paylore
        </Link>
      </section>
    </div>
  );
}
