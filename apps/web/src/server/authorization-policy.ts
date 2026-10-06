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