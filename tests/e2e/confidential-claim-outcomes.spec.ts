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

async function clickAndWaitForClaimResponse(page: Page): Promise<void> {
  const response = page.waitForResponse((candidate) =>
    claimRoute.test(new URL(candidate.url()).pathname) &&
    candidate.request().method() === "POST",
  { timeout: 10_000 }).catch(() => null);
  await page.getByRole("button", { name: "Claim & Cash Out" }).click();
  if (!await response) {
    test.skip(true, "The test workspace has no allocation with a committed Claim PDA and creation signature.");
  }
}

test.describe("confidential claim rendered outcomes", () => {
  test("renders settlement success only from the handled claim response", async ({ browser }) => {
    test.skip(!process.env.PAYLORE_E2E_SETTLEMENT_URL || !process.env.PAYLORE_E2E_STORAGE_STATE,
      "Requires the explicit authorized hosted Devnet test account.");
    const { context, page } = await openAuthorizedCompensationPage(browser);
    try {
      await requireSafeActionPreconditions(page);
      await page.route(claimRoute, async (route) => {
        if (route.request().method() !== "POST") {
          await route.continue();
          return;
        }
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

      await clickAndWaitForClaimResponse(page);
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
      await page.route(claimRoute, async (route) => {
        if (route.request().method() !== "POST") {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ status: "pending", signature: "test-fixture-pending-signature" })
        });
      });

      await clickAndWaitForClaimResponse(page);
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
      await page.route(claimRoute, async (route) => {
        if (route.request().method() !== "POST") {
          await route.continue();
          return;
        }
        await route.fulfill({
          status: 200,
          contentType: "application/json",
          body: JSON.stringify({ status: "state_conflict", signature: "test-fixture-conflict-signature" })
        });
      });

      await clickAndWaitForClaimResponse(page);
      await expect(page.getByRole("alert").filter({ hasText: /No second transfer was attempted/ })).toBeVisible();
      await expect(page.getByText(/transferred and reconciled/)).toHaveCount(0);
    } finally {
      await context.close();
    }
  });

  test("renders cleanup-pending completion as partial rather than fully successful", async ({ browser }) => {
    test.skip(!process.env.PAYLORE_E2E_SETTLEMENT_URL || !process.env.PAYLORE_E2E_STORAGE_STATE,
      "Requires the explicitly authorized hosted Devnet contributor.");
    const { context, page } = await openAuthorizedCompensationPage(browser);
    try {
      await requireSafeActionPreconditions(page);
      await page.route(claimRoute, async (route) => {
        if (route.request().method() !== "POST") { await route.continue(); return; }
        await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({
          status: "claimed", signature: "test-fixture-cleanup-pending-signature",
          warning: "proof_context_cleanup_pending", amountBaseUnits: "1000000", proofDurationMs: 1
        }) });
      });
      await clickAndWaitForClaimResponse(page);
      await expect(page.getByRole("status").filter({ hasText: /need proof-context cleanup/ })).toBeVisible();
      await expect(page.getByRole("alert")).toHaveCount(0);
      await expect(page.getByText(/transferred and reconciled/)).toHaveCount(0);
    } finally { await context.close(); }
  });

  test("renders failed claim responses as an actionable error, never as success", async ({ browser }) => {
    test.skip(!process.env.PAYLORE_E2E_SETTLEMENT_URL || !process.env.PAYLORE_E2E_STORAGE_STATE,
      "Requires the explicitly authorized hosted Devnet contributor.");
    const { context, page } = await openAuthorizedCompensationPage(browser);
    try {
      await requireSafeActionPreconditions(page);
      await page.route(claimRoute, async (route) => {
        if (route.request().method() !== "POST") { await route.continue(); return; }
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "temporarily_unavailable" }) });
      });
      await clickAndWaitForClaimResponse(page);
      await expect(page.getByRole("alert").filter({
        hasText: /need attention\. Unverified transfers are not shown as complete/
      })).toBeVisible();
      await expect(page.getByText(/transferred and reconciled/)).toHaveCount(0);
    } finally { await context.close(); }
  });

  test("keeps Claim PDA allocations isolated between contributor wallet sessions", async ({ browser }) => {
    const url = process.env.PAYLORE_E2E_SETTLEMENT_URL;
    const primaryStorageState = process.env.PAYLORE_E2E_STORAGE_STATE;
    const otherStorageState = process.env.PAYLORE_E2E_OTHER_STORAGE_STATE;
    test.skip(!url || !primaryStorageState || !otherStorageState,
      "Requires two authorized contributor storage states in the same workspace.");
    const primaryContext = await browser.newContext({ storageState: primaryStorageState! });
    const otherContext = await browser.newContext({ storageState: otherStorageState! });
    try {
      const primaryPage = await primaryContext.newPage();
      const otherPage = await otherContext.newPage();
      await Promise.all([primaryPage.goto(url!), otherPage.goto(url!)]);
      await Promise.all([
        expect(primaryPage.getByRole("heading", { name: "Your compensation" })).toBeVisible(),
        expect(otherPage.getByRole("heading", { name: "Your compensation" })).toBeVisible()
      ]);
      const primaryClaims = (await primaryPage.locator("table tbody tr td:nth-child(4) code").allTextContents()).map(v => v.trim()).filter(Boolean);
      const otherClaims = (await otherPage.locator("table tbody tr td:nth-child(4) code").allTextContents()).map(v => v.trim()).filter(Boolean);
      expect(primaryClaims.length, "The primary test contributor must have at least one Claim PDA allocation").toBeGreaterThan(0);
      expect(otherClaims.length, "The second contributor must have at least one Claim PDA allocation").toBeGreaterThan(0);
      const primaryClaimSet = new Set(primaryClaims);
      expect(otherClaims.some(claimAddress => primaryClaimSet.has(claimAddress)),
        "A Claim PDA assigned to the first wallet must never appear in the second wallet's compensation table").toBe(false);
    } finally { await Promise.all([primaryContext.close(), otherContext.close()]); }
  });

});
