import "server-only";

import {
  consumeWorkspaceCreationAttempt,
  createWorkspaceWithAdminMembership,
  type Database
} from "@paylore/database";

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
      Math.ceil(
        remainingMs / 1000
      )
    )
  };
}

export class WorkspaceCreationRateLimitError extends Error {
  readonly retryAfterSeconds: number;

  constructor(
    retryAfterSeconds: number
  ) {
    super(
      "Workspace creation is temporarily rate limited."
    );
    this.name =
      "WorkspaceCreationRateLimitError";
    this.retryAfterSeconds =
      retryAfterSeconds;
  }
}

export async function createWorkspaceForUser(
  db: Database,
  input: {
    userId: string;
    name: string;
  }
) {
  const limit =
    await consumeWorkspaceCreationAttempt(
      db,
      input.userId
    );

  const elapsedMs =
    limit.elapsedSeconds * 1000;

  const decision =
    decideWorkspaceCreation(
      limit.attemptCount,
      elapsedMs
    );

  if (!decision.allowed) {
    throw new WorkspaceCreationRateLimitError(
      decision.retryAfterSeconds
    );
  }

  return createWorkspaceWithAdminMembership(
    db,
    input
  );
}