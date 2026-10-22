"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

export default function ContributorLeftWorkspacePage() {
  const router = useRouter();

  return (
    <main className="protected-wrap workspace-page">
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
        <button className="button" onClick={() => router.replace("/")} type="button">
          Refresh and return to Paylore
        </button>
      </section>
    </main>
  );
}
