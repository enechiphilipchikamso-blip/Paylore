import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const emptyStateFiles = [
  "../components/workspace/ContributorCompensation.tsx",
  "../components/workspace/ContributorDirectory.tsx",
  "../components/workspace/NotificationCenter.tsx",
  "../components/workspace/BillingActions.tsx",
  "../components/workspace/GasTankActions.tsx",
  "./workspace/[workspaceId]/payroll/page.tsx",
  "./workspace/[workspaceId]/ledger/page.tsx",
  "./workspace/[workspaceId]/recovery/page.tsx"
];

describe("workspace dashboard collection empty states", () => {
  it("uses the shared designed empty state for contributor and finance collections", async () => {
    const sources = await Promise.all(
      emptyStateFiles.map((path) => readFile(new URL(path, import.meta.url), "utf8"))
    );

    for (const source of sources) {
      expect(source).toContain("workspace-empty-state");
    }
  });
});
