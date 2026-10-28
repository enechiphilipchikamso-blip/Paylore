"use client";

import type { ClaimAndCashOutOutcome } from "./claim-and-cash-out-outcome";

export type ClaimAndCashOutStatusMessage = ClaimAndCashOutOutcome | null;

/** Renders one consistent accessible status surface for every claim/cash-out outcome. */
export function ClaimAndCashOutStatus({ message }: { message: ClaimAndCashOutStatusMessage }) {
  if (!message) return null;

  return (
    <div
      className="state-callout"
      data-state={message.state}
      data-testid="claim-and-cash-out-outcome"
      role={message.state === "error" ? "alert" : "status"}
    >
      <span className="state-callout__signal" aria-hidden="true" />
      <p>{message.text}</p>
    </div>
  );
}
