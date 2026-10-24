import { expect, test } from "@playwright/test";

test.describe("workspace payroll recovery queue", () => {
  test("opens the scoped recovery list and a read-only allocation detail", async ({ browser }) => {
    test.skip(
      !process.env.PAYLORE_E2E_RECOVERY_URL || !process.env.PAYLORE_E2E_STORAGE_STATE,
      "Requires an explicitly authorized organization-administrator Devnet workspace."
    );

    const context = await browser.newContext({
      storageState: process.env.PAYLORE_E2E_STORAGE_STATE
    });
    const page = await context.newPage();
    const recoverySubmissions: string[] = [];
    await page.route(/\/api\/workspaces\/[^/]+\/payroll\/runs\/[^/]+\/allocations\/[^/]+\/recovery$/, async (route) => {
      if (route.request().method() === "POST") recoverySubmissions.push(route.request().url());
      await route.continue();
    });

    try {
      await page.goto(process.env.PAYLORE_E2E_RECOVERY_URL!);
      await expect(page.getByRole("heading", { name: "Recover unclaimed payroll" })).toBeVisible();
      await expect(page.getByRole("heading", { name: "Recovery queue" })).toBeVisible();
      await expect(page.getByText(/Financial recovery is unavailable until the confidential reserve restoration can be verified/)).toBeVisible();

      const reviewLinks = page.getByRole("link", { name: "Review allocation" });
      if (await reviewLinks.count() === 0) {
        await expect(page.getByText("No unclaimed payroll allocations are currently in the recovery queue.")).toBeVisible();
        return;
      }

      await reviewLinks.first().click();
      await expect(page.getByRole("heading", { name: "Allocation detail" })).toBeVisible();
      await expect(page.getByRole("link", { name: "Back to recovery queue" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Recovery unavailable" })).toBeDisabled();
      await expect(page.getByText(/Financial recovery is unavailable/)).toBeVisible();
      expect(recoverySubmissions).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
