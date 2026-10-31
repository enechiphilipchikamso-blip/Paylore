"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { WorkspaceRole } from "../../server/authorization-policy";
import {
  getWorkspaceNavigationGroups,
  isWorkspaceNavigationItemActive
} from "./workspace-navigation-policy";

export function WorkspaceNavigationLinks({
  workspaceId,
  role
}: {
  workspaceId: string;
  role: WorkspaceRole;
}) {
  const pathname = usePathname();
  const groups = getWorkspaceNavigationGroups(workspaceId, role);

  function renderGroups() {
    return groups.map((group) => (
      <section className="workspace-nav-group" key={group.label}>
        <p className="workspace-nav-group__label">{group.label}</p>
        <ul>
          {group.items.map((item) => {
            const active = isWorkspaceNavigationItemActive(pathname, item.href, workspaceId);
            return (
              <li key={item.href}>
                <Link
                  aria-current={active ? "page" : undefined}
                  className="workspace-nav-link"
                  href={item.href}
                >
                  {item.label}
                </Link>
              </li>
            );
          })}
        </ul>
      </section>
    ));
  }

  return (
    <>
      <nav aria-label="Workspace navigation" className="workspace-nav-desktop">
        {renderGroups()}
      </nav>
      <details className="workspace-nav-mobile">
        <summary>
          <span>Workspace menu</span>
          <span aria-hidden="true" className="workspace-nav-mobile__chevron" />
        </summary>
        <nav aria-label="Workspace navigation">{renderGroups()}</nav>
      </details>
    </>
  );
}
