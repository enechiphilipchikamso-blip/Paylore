import { describe, expect, it } from "vitest";
import {
  getWorkspaceNavigationGroups,
  isWorkspaceNavigationItemActive
} from "./workspace-navigation-policy";

function hrefs(role: "organization_admin" | "finance_auditor" | "contributor") {
  return getWorkspaceNavigationGroups("workspace-a", role).flatMap(group => group.items.map(item => item.href));
}

describe("workspace navigation policy", () => {
  it("includes administrator destinations", () => {
    const items = hrefs("organization_admin");
    expect(items).toContain("/workspace/workspace-a/contributors/invitations");
    expect(items).toContain("/workspace/workspace-a/recovery");
    expect(items).toContain("/workspace/workspace-a/settings/reserve");
    expect(items).toContain("/workspace/workspace-a/settings/deletion");
  });

  it("labels Finance/Auditor destinations as finance navigation and keeps administrator-only links out", () => {
    const groups = getWorkspaceNavigationGroups("workspace-a", "finance_auditor");
    const items = groups.flatMap((group) => group.items.map((item) => item.href));
    expect(groups.map((group) => group.label)).toEqual(["Overview", "Finance", "Workspace"]);
    expect(items).toContain("/workspace/workspace-a/billing");
    expect(items).toContain("/workspace/workspace-a/ledger");
    expect(items).not.toContain("/workspace/workspace-a/contributors/invitations");
    expect(items).not.toContain("/workspace/workspace-a/recovery");
    expect(items).not.toContain("/workspace/workspace-a/settings/reserve");
    expect(items).not.toContain("/workspace/workspace-a/settings/deletion");
  });

  it("limits contributor navigation to home, compensation and personal notifications", () => {
    expect(hrefs("contributor")).toEqual([
      "/workspace/workspace-a",
      "/workspace/workspace-a/compensation",
      "/workspace/workspace-a/notifications"
    ]);
  });

  it("keeps exactly the relevant nested section active", () => {
    expect(isWorkspaceNavigationItemActive("/workspace/workspace-a/payroll/run-1", "/workspace/workspace-a/payroll", "workspace-a")).toBe(true);
    expect(isWorkspaceNavigationItemActive("/workspace/workspace-a/contributors/invitations", "/workspace/workspace-a/contributors", "workspace-a")).toBe(false);
    expect(isWorkspaceNavigationItemActive("/workspace/workspace-a/settings/reserve", "/workspace/workspace-a/settings", "workspace-a")).toBe(false);
    expect(isWorkspaceNavigationItemActive("/workspace/workspace-a/settings/reserve", "/workspace/workspace-a/settings/reserve", "workspace-a")).toBe(true);
  });
});
