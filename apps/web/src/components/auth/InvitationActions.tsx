"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { BusyActionButton } from "../workspace/BusyActionButton";

function shortWallet(value: string) {
  return value.length > 12 ? `${value.slice(0, 4)}…${value.slice(-4)}` : value;
}

/**
 * Wrong-wallet recovery. "Retry verification" re-reads the server session; if
 * the session still holds the same wallet the page cannot change, so the result
 * is reported explicitly instead of silently re-rendering the same state.
 */
export function InvitationActions({
  authPath,
  sessionWalletAddress
}: {
  authPath: string;
  sessionWalletAddress: string;
}) {
  const router = useRouter();
  const [checking, startTransition] = useTransition();
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [attempts, setAttempts] = useState(0);

  function retryVerification() {
    startTransition(() => {
      router.refresh();
      // Applied when the refreshed page commits; a matching wallet replaces this view entirely.
      setCheckedAt(new Date());
      setAttempts((count) => count + 1);
    });
  }

  return (
    <div className="invitation-wrong-wallet">
      <dl className="reserve-facts">
        <div className="reserve-facts__wide">
          <dt>Signed in to Paylore with</dt>
          <dd><code title={sessionWalletAddress}>{shortWallet(sessionWalletAddress)}</code></dd>
        </div>
      </dl>
      <div className="reserve-panel__status" aria-live="polite">
        {checking ? (
          <p className="loading-indicator" role="status">
            <span className="loading-indicator__icon" aria-hidden="true" />
            Checking the authenticated wallet against this invitation…
          </p>
        ) : checkedAt ? (
          <div className="state-callout" data-state="error" role="alert">
            <span className="state-callout__signal" aria-hidden="true" />
            <p>
              Checked at {checkedAt.toLocaleTimeString()}
              {attempts > 1 ? ` (attempt ${attempts})` : ""}: your Paylore session is
              still signed in with {shortWallet(sessionWalletAddress)}, which does not match this
              invitation. Changing the account in your wallet extension does not change the
              Paylore session. Choose Switch wallet and sign in with the invited wallet.
            </p>
          </div>
        ) : null}
      </div>
      <div className="hero__actions">
        <Link className="button" href={authPath}>
          Switch wallet
        </Link>
        <BusyActionButton
          className="button button--secondary"
          busy={checking}
          onClick={retryVerification}
          type="button"
        >
          {checking ? "Checking…" : "Retry verification"}
        </BusyActionButton>
      </div>
    </div>
  );
}
