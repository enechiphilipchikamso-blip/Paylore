import "server-only";

import {
  getWorkspaceForUser,
  type Database
} from "@paylore/database";
import {
  roleAllows,
  WORKSPACE_ROLE_LABELS
} from "./authorization-policy";

export {
  roleAllows,
  WORKSPACE_ROLE_LABELS
} from "./authorization-policy";

export type {
  WorkspaceRole
} from "./authorization-policy";

export class WorkspaceAuthorizationError extends Error {
  constructor() {
    super(
      "Workspace authorization failed."
    );
    this.name =
      "WorkspaceAuthorizationError";
  }
}

export async function requireWorkspaceMember(
  db: Database,
  userId: string,
  workspaceId: string
) {
  const membership =
    await getWorkspaceForUser(
      db,
      userId,
      workspaceId
    );

  if (!membership) {
    throw new WorkspaceAuthorizationError();
  }

  return membership;
}