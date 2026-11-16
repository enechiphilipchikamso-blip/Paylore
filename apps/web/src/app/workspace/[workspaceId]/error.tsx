"use client";

import { useState } from "react";

export default function WorkspaceError({
  error,
  reset
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [retrying, setRetrying] = useState(false);

  function retry() {
    if (retrying) return;
    setRetrying(true);
    reset();
  }

  return (
    <section className="protected-wrap workspace-page">
      <header className="protected-header">
        <p className="eyebrow">Workspace</p>
        <h2>We couldn&apos;t load this page</h2>
        <p>
          Your workspace information could not be retrieved. Refresh the page
          state to try again.
        </p>
      </header>
      <section className="surface-card" aria-labelledby="workspace-error-title">
        <div className="state-callout" data-state="error" role="alert">
          <span className="state-callout__signal" aria-hidden="true" />
          <p id="workspace-error-title">
            The page did not finish loading. No workspace change has been
            confirmed.
            {/* Next.js digest: a hash, never the error text. It matches the
                server log entry for this failure, so support can find the cause. */}
            {error.digest ? ` Reference: ${error.digest}.` : ""}
          </p>
        </div>
        <button
          className="button"
          disabled={retrying}
          aria-busy={retrying}
          onClick={retry}
          type="button"
        >
          {retrying ? "Retrying…" : "Try again"}
        </button>
      </section>
    </section>
  );
}
