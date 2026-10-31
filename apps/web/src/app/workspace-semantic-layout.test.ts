import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const nestedWorkspacePages = [
  "./workspace/[workspaceId]/billing/page.tsx",
  "./workspace/[workspaceId]/contributors/import/page.tsx",
  "./workspace/[workspaceId]/contributors/invitations/page.tsx",
  "./workspace/[workspaceId]/contributors/page.tsx",
  "./workspace/[workspaceId]/gas-tank/page.tsx",
  "./workspace/[workspaceId]/ledger/page.tsx",
  "./workspace/[workspaceId]/notifications/page.tsx",
  "./workspace/[workspaceId]/payroll/[runId]/page.tsx",
  "./workspace/[workspaceId]/payroll/page.tsx",
  "./workspace/[workspaceId]/recovery/[runId]/[allocationId]/page.tsx",
  "./workspace/[workspaceId]/recovery/page.tsx",
  "./workspace/[workspaceId]/settings/deletion/page.tsx",
  "./workspace/[workspaceId]/settings/reserve/page.tsx",
  "./workspace/[workspaceId]/settings/page.tsx",
  "./workspace/[workspaceId]/compensation/page.tsx",
  "./workspace/[workspaceId]/contributors/left/page.tsx"
];

describe("workspace page landmarks", () => {
  it("keeps route content inside the shared PublicShell main landmark", async () => {
    const pages = await Promise.all(
      nestedWorkspacePages.map((path) =>
        readFile(new URL(path, import.meta.url), "utf8")
      )
    );

    for (const page of pages) {
      expect(page).not.toMatch(/<main\b/);
      expect(page).toContain('className="protected-wrap workspace-page"');
    }
  });
});
