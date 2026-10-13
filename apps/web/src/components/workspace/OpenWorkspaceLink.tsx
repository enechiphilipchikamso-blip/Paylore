"use client";

import Link from "next/link";
import { useRef, useState, type MouseEvent } from "react";

export function OpenWorkspaceLink({
  workspaceId
}: {
  workspaceId: string;
}) {
  const openingRef = useRef(false);
  const [opening, setOpening] = useState(false);

  function handleClick(event: MouseEvent<HTMLAnchorElement>) {
    if (
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.shiftKey ||
      event.altKey ||
      (event.currentTarget.target && event.currentTarget.target !== "_self")
    ) {
      return;
    }

    if (openingRef.current) {
      event.preventDefault();
      return;
    }

    openingRef.current = true;
    setOpening(true);
  }

  return (
    <Link
      aria-busy={opening}
      className="button"
      href={`/workspace/${workspaceId}`}
      onClick={handleClick}
    >
      <span
        aria-atomic="true"
        aria-live="polite"
        className="open-workspace-link__content"
        role={opening ? "status" : undefined}
      >
        {opening ? (
          <>
            <span
              aria-hidden="true"
              className="loading-indicator__icon"
            />
            Opening Workspace...
          </>
        ) : (
          "Open Workspace"
        )}
      </span>
    </Link>
  );
}
