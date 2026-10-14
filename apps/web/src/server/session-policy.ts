export const SESSION_INACTIVITY_MS =
  12 * 60 * 60 * 1000;

export const SESSION_HARD_LIFETIME_MS =
  7 * 24 * 60 * 60 * 1000;

export type SessionEvaluation =
  | {
      status: "authenticated";
    }
  | {
      status: "inactivity_expired";
    }
  | {
      status: "hard_expired";
    };

export function evaluateSession(
  input: {
    issuedAt: Date;
    lastSeenAt: Date;
    expiresAt: Date;
  },
  now: Date
): SessionEvaluation {
  if (
    now.getTime() >=
    input.expiresAt.getTime()
  ) {
    return {
      status: "hard_expired"
    };
  }

  if (
    now.getTime() -
      input.lastSeenAt.getTime() >=
    SESSION_INACTIVITY_MS
  ) {
    return {
      status: "inactivity_expired"
    };
  }

  return {
    status: "authenticated"
  };
}