export const WORKSPACE_CREATION_WINDOW_MS =
  15 * 60 * 1000;

export const WORKSPACE_CREATION_MAX_ATTEMPTS = 5;

export type WorkspaceCreationDecision = {
  allowed: boolean;
  retryAfterSeconds: number;
};

export function decideWorkspaceCreation(
  attemptCount: number,
  elapsedMs: number
): WorkspaceCreationDecision {
  if (
    attemptCount <=
    WORKSPACE_CREATION_MAX_ATTEMPTS
  ) {
    return {
      allowed: true,
      retryAfterSeconds: 0
    };
  }

  const remainingMs = Math.max(
    0,
    WORKSPACE_CREATION_WINDOW_MS -
      elapsedMs
  );

  return {
    allowed: false,
    retryAfterSeconds: Math.max(
      1,
      Math.ceil(remainingMs / 1000)
    )
  };
}