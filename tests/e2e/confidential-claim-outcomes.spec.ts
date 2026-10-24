import { expect, test, type Browser, type Page } from "@playwright/test";

const claimRoute = /\/api\/workspaces\/[^/]+\/payroll\/runs\/[^/]+\/allocations\/[^/]+\/claim$/;

async function openAuthorizedCompensationPage(browser: Browser): Promise<{
  context: Awaited<ReturnType<Browser["newContext"]>>;
  page: Page;
}> {
  const url = process.env.PAYLORE_E2E_SETTLEMENT_URL;
  const storageState = process.env.PAYLORE_E2E_STORAGE_STATE;
  if (!url || !storageState) {
    throw new Error("The authorized compensation URL and storage state are required for this hosted UI outcome test.");
  }
  const context = await browser.newContext({ storageState });
  const page = await context.newPage();
  await page.goto(url);
  await expect(page.getByRole("heading", { name: "Your compensation" })).toBeVisible();
  return { context, page };
}

async function requireSafeActionPreconditions(page: Page): Promise<void> {
  const action = page.getByRole("button", { name: "Claim & Cash Out" });
  const readyAccount = page.getByText("Ready", { exact: true });
  if (!(await action.isVisible().catch(() => false)) ||
      !(await readyAccount.isVisible().catch(() => false))) {
    test.skip(true, "The authorized test wallet needs a ready confidential account and at least one unsettled allocation.");
  }
}

test.describe("confidential claim rendered outcomes", () => {
  test("renders settlement success only from the handled claim response", async ({ browser }) => {
    test.skip(!process.env.PAYLORE_E2E_SETTLEMENT_URL || !process.env.PAYLORE_E2E_STORAGE_STATE,
      "Requires the explicit authorized hosted Devnet test account.");
    const { context, page } = await openAuthorizedCompensationPage(browser);
    try {
      await requireSafeActionPreconditions(page);
      let intercepted = 0;
      await page.route(claimRoute, async (route) => {
        if (route.request().method() !== "POST") {
          await route.continue();
          return;
        }
        intercepted++;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({
            status: "claimed",
            signature: "test-fixture-only-signature",
            amountBaseUnits: "1000000",
            proofDurationMs: 1
          })
        });
      });

      await page.getByRole("button", { name: "Claim & Cash Out" }).click();
      if (intercepted === 0) test.skip(true, "The test workspace has no allocation with a committed Claim PDA and creation signature.");
      await expect(page.getByRole("status").filter({
        hasText: /confidential payroll allocation\(s\) transferred and reconciled/
      })).toBeVisible();
      await expect(page.getByText(/No second transfer was attempted/)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("shows pending finality without reporting a completed payment", async ({ browser }) => {
    test.skip(!process.env.PAYLORE_E2E_SETTLEMENT_URL || !process.env.PAYLORE_E2E_STORAGE_STATE,
      "Requires the explicit authorized hosted Devnet test account.");
    const { context, page } = await openAuthorizedCompensationPage(browser);
    try {
      await requireSafeActionPreconditions(page);
      let intercepted = 0;
      await page.route(claimRoute, async (route) => {
        if (route.request().method() !== "POST") {
          await route.continue();
          return;
        }
        intercepted++;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ status: "pending", signature: "test-fixture-pending-signature" })
        });
      });

      await page.getByRole("button", { name: "Claim & Cash Out" }).click();
      if (intercepted === 0) test.skip(true, "The test workspace has no allocation with a committed Claim PDA and creation signature.");
      await expect(page.getByRole("status").filter({ hasText: /await finality or retry/ })).toBeVisible();
      await expect(page.getByText(/transferred and reconciled/)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("renders claim/recovery conflict as an error, never as successful settlement", async ({ browser }) => {
    test.skip(!process.env.PAYLORE_E2E_SETTLEMENT_URL || !process.env.PAYLORE_E2E_STORAGE_STATE,
      "Requires the explicit authorized hosted Devnet test account.");
    const { context, page } = await openAuthorizedCompensationPage(browser);
    try {
      await requireSafeActionPreconditions(page);
      let intercepted = 0;
      await page.route(claimRoute, async (route) => {
        if (route.request().method() !== "POST") {
          await route.continue();
          return;
        }
        intercepted++;
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ status: "state_conflict", signature: "test-fixture-conflict-signature" })
        });
      });

      await page.getByRole("button", { name: "Claim & Cash Out" }).click();
      if (intercepted === 0) test.skip(true, "The test workspace has no allocation with a committed Claim PDA and creation signature.");
      await expect(page.getByRole("alert").filter({ hasText: /No second transfer was attempted/ })).toBeVisible();
      await expect(page.getByText(/transferred and reconciled/)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });
});
