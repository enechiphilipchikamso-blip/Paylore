import "server-only";

import {
  consumeWorkspaceCreationAttempt,
  createWorkspaceWithAdminMembership,
  type Database
} from "@paylore/database";
import {
  decideWorkspaceCreation,
  WORKSPACE_CREATION_MAX_ATTEMPTS,
  WORKSPACE_CREATION_WINDOW_MS
} from "./workspaces-policy";

export {
  decideWorkspaceCreation,
  WORKSPACE_CREATION_MAX_ATTEMPTS,
  WORKSPACE_CREATION_WINDOW_MS
} from "./workspaces-policy";

export type {
  WorkspaceCreationDecision
} from "./workspaces-policy";

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

  const decision =
    decideWorkspaceCreation(
      limit.attemptCount,
      limit.elapsedSeconds * 1000
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