import { expect, test, type Browser, type Page } from "@playwright/test";

const outcomeUrl = process.env.PAYLORE_E2E_CLAIM_OUTCOME_URL;
const walletAState = process.env.PAYLORE_E2E_CLAIM_STORAGE_STATE;
const walletAAllocation = process.env.PAYLORE_E2E_CLAIM_ALLOCATION_ID;
const walletBState = process.env.PAYLORE_E2E_CLAIM_OTHER_WALLET_STORAGE_STATE;
const walletBAllocation = process.env.PAYLORE_E2E_CLAIM_OTHER_ALLOCATION_ID;
const matrixConfigured = Boolean(outcomeUrl && walletAState && walletAAllocation);
const isolationConfigured = Boolean(
  outcomeUrl && walletAState && walletAAllocation && walletBState && walletBAllocation
);
const claimPath = /\/api\/workspaces\/[^/]+\/payroll\/runs\/[^/]+\/allocations\/([^/]+)\/claim$/;

type MockOutcome = {
  name: string;
  state: "success" | "partial" | "error";
  body: Record<string, unknown>;
  httpStatus?: number;
  text: RegExp;
};

const outcomes: MockOutcome[] = [
  {
    name: "finalized claim",
    state: "success",
    body: { status: "claimed", signature: "test-settlement-signature", amountBaseUnits: "1000000" },
    text: /1 confidential payroll allocation\(s\) transferred and reconciled/
  },
  {
    name: "idempotent already-settled claim",
    state: "success",
    body: { status: "already_settled", signature: "test-settlement-signature", amountBaseUnits: "1000000" },
    text: /1 confidential payroll allocation\(s\) transferred and reconciled/
  },
  {
    name: "pending finality",
    state: "partial",
    body: { status: "pending", signature: "test-settlement-signature" },
    text: /0 allocation\(s\) settled; 1 await finality or retry/
  },
  {
    name: "retry-ready failure",
    state: "partial",
    body: { status: "retry_ready", signature: "test-settlement-signature" },
    text: /0 allocation\(s\) settled; 1 await finality or retry/
  },
  {
    name: "workspace busy",
    state: "partial",
    body: { status: "workspace_busy" },
    text: /0 allocation\(s\) settled; 1 await finality or retry/
  },
  {
    name: "transfer reconciled but proof cleanup pending",
    state: "partial",
    body: { status: "claimed", warning: "proof_context_cleanup_pending" },
    text: /1 allocation\(s\) settled; 0 await finality or retry, and 1 need proof-context cleanup/
  },
  {
    name: "server failure",
    state: "error",
    httpStatus: 503,
    body: { error: "confidential_settlement_failed" },
    text: /0 allocation\(s\) settled; 1 need attention/
  },
  {
    name: "Claim PDA state conflict",
    state: "error",
    body: { status: "state_conflict", signature: "test-settlement-signature" },
    text: /No second transfer was attempted/
  }
];

async function openReadyContributorPage(
  browser: Browser,
  storageState: string,
  ownAllocationId: string,
  otherAllocationId?: string
): Promise<{ page: Page; close: () => Promise<void> }> {
  const context = await browser.newContext({ storageState, serviceWorkers: "block" });
  const page = await context.newPage();
  await page.goto(outcomeUrl!);
  await expect(page.getByRole("heading", { name: "Your compensation" })).toBeVisible();
  const accountStatus = await page.locator(".billing-period dd").nth(1).textContent();
  if (accountStatus?.trim() !== "Ready") {
    await context.close();
    test.skip(
      true,
      "Use an authenticated contributor with a verified confidential account; this spec never signs account setup or payroll transactions."
    );
  }
  await expect(page.getByTestId(`payroll-allocation-${ownAllocationId}`)).toBeVisible();
  if (otherAllocationId) {
    await expect(page.getByTestId(`payroll-allocation-${otherAllocationId}`)).toHaveCount(0);
  }
  return { page, close: () => context.close() };
}

async function mockClaimEndpoint(
  page: Page,
  body: Record<string, unknown>,
  status = 200
): Promise<string[]> {
  const requestedAllocationIds: string[] = [];
  await page.route(claimPath, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    const allocationId = new URL(route.request().url()).pathname.match(claimPath)?.[1];
    if (allocationId) requestedAllocationIds.push(allocationId);
    await route.fulfill({
      status,
      contentType: "application/json",
      body: JSON.stringify(body)
    });
  });
  return requestedAllocationIds;
}

test.describe("rendered Claim & Cash Out outcomes", () => {
  test("renders each success, partial, retry, error and conflict result from its API outcome", async ({ browser }) => {
    test.skip(
      !matrixConfigured,
      "Configure PAYLORE_E2E_CLAIM_OUTCOME_URL, PAYLORE_E2E_CLAIM_STORAGE_STATE and PAYLORE_E2E_CLAIM_ALLOCATION_ID for a safe authenticated fixture."
    );
    for (const outcome of outcomes) {
      const fixture = await openReadyContributorPage(browser, walletAState!, walletAAllocation!);
      try {
        const requested = await mockClaimEndpoint(
          fixture.page, outcome.body, outcome.httpStatus ?? 200
        );
        await fixture.page.getByRole("button", { name: "Claim & Cash Out" }).click();
        const callout = fixture.page.getByTestId("claim-and-cash-out-outcome");
        await expect(callout).toHaveAttribute("data-state", outcome.state);
        await expect(callout).toContainText(outcome.text);
        await expect(callout).toHaveAttribute("role", outcome.state === "error" ? "alert" : "status");
        expect(requested).toEqual([walletAAllocation]);
      } finally {
        await fixture.close();
      }
    }
  });

  test("isolates allocation rows and outcome state between two contributor wallets", async ({ browser }) => {
    test.skip(
      !isolationConfigured,
      "Also configure PAYLORE_E2E_CLAIM_OTHER_WALLET_STORAGE_STATE and PAYLORE_E2E_CLAIM_OTHER_ALLOCATION_ID for a second contributor in the same workspace."
    );
    const first = await openReadyContributorPage(
      browser, walletAState!, walletAAllocation!, walletBAllocation!
    );
    try {
      const firstRequests = await mockClaimEndpoint(first.page, {
        status: "state_conflict", signature: "wallet-a-test-signature"
      });
      await first.page.getByRole("button", { name: "Claim & Cash Out" }).click();
      await expect(first.page.getByTestId("claim-and-cash-out-outcome"))
        .toContainText("No second transfer was attempted");
      expect(firstRequests).toEqual([walletAAllocation]);
    } finally {
      await first.close();
    }

    const second = await openReadyContributorPage(
      browser, walletBState!, walletBAllocation!, walletAAllocation!
    );
    try {
      const secondRequests = await mockClaimEndpoint(second.page, {
        status: "claimed", signature: "wallet-b-test-signature", amountBaseUnits: "1000000"
      });
      await expect(second.page.getByTestId("claim-and-cash-out-outcome")).toHaveCount(0);
      await second.page.getByRole("button", { name: "Claim & Cash Out" }).click();
      const outcome = second.page.getByTestId("claim-and-cash-out-outcome");
      await expect(outcome).toHaveAttribute("data-state", "success");
      await expect(outcome).not.toContainText("No second transfer was attempted");
      expect(secondRequests).toEqual([walletBAllocation]);
    } finally {
      await second.close();
    }
  });
});
