import type { WorkspaceRole } from "../../server/authorization-policy";

export type WorkspaceNavigationItem = { label: string; href: string };
export type WorkspaceNavigationGroup = { label: string; items: WorkspaceNavigationItem[] };

export function getWorkspaceNavigationGroups(
  workspaceId: string,
  role: WorkspaceRole
): WorkspaceNavigationGroup[] {
  const base = `/workspace/${workspaceId}`;
  const groups: WorkspaceNavigationGroup[] = [
    { label: "Overview", items: [{ label: "Home", href: base }] }
  ];

  if (role === "contributor") {
    groups.push({
      label: "Your workspace",
      items: [
        { label: "Your compensation", href: `${base}/compensation` },
        { label: "Notifications", href: `${base}/notifications` }
      ]    });
    return groups;
  }

  groups.push({
    label: role === "finance_auditor" ? "Finance" : "Operations",
    items: [
      { label: "Payroll", href: `${base}/payroll` },
      { label: "Contributors", href: `${base}/contributors` },
      { label: "Billing", href: `${base}/billing` },
      { label: "Ledger", href: `${base}/ledger` },
      { label: "Notifications", href: `${base}/notifications` },
      { label: "Gas Tank", href: `${base}/gas-tank` }
    ]
  });

  groups.push({
    label: "Workspace",
    items: [
      ...(role === "organization_admin"
        ? [
            { label: "Invitations", href: `${base}/contributors/invitations` },
            { label: "Recovery", href: `${base}/recovery` },
            { label: "Confidential reserve", href: `${base}/settings/reserve` },
            { label: "Data retention", href: `${base}/settings/deletion` }
          ]
        : []),
      { label: "Settings", href: `${base}/settings` }
    ]
  });

  return groups;
}

export function isWorkspaceNavigationItemActive(
  pathname: string,
  href: string,
  workspaceId: string
): boolean {
  const base = `/workspace/${workspaceId}`;
  if (pathname === href) return true;
  if (href === base || href === `${base}/settings`) return false;
  if (href === `${base}/contributors`) {
    return pathname.startsWith(`${href}/`) &&
      !pathname.startsWith(`${base}/contributors/invitations`);
  }
  return pathname.startsWith(`${href}/`);
}
