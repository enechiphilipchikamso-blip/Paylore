import "server-only";

import {
  getWorkspaceForUser,
  type Database
} from "@paylore/database";

export type WorkspaceRole =
  | "organization_admin"
  | "finance_auditor"
  | "contributor";

export const WORKSPACE_ROLE_LABELS: Record<
  WorkspaceRole,
  string
> = {
  organization_admin:
    "Organization Administrator",
  finance_auditor: "Finance/Auditor",
  contributor: "Contributor"
};

export function roleAllows(
  role: WorkspaceRole,
  allowedRoles: readonly WorkspaceRole[]
): boolean {
  return allowedRoles.includes(role);
}

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