"use client";

import Link from "next/link";

export function InvitationActions({
  authPath,
  retryPath
}: {
  authPath: string;
  retryPath: string;
}) {
  return (
    <div className="hero__actions">
      <Link
        className="button"
        href={authPath}
      >
        Switch wallet
      </Link>

      <Link
        className="button button--secondary"
        href={retryPath}
      >
        Retry verification
      </Link>
    </div>
  );
}