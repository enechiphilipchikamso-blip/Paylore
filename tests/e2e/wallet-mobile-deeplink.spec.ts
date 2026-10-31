import { expect, test } from "@playwright/test";

test("mobile browser builds a Solflare connect request with the real app and return URLs", async ({
  page
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "userAgent", {
      configurable: true,
      get: () =>
        "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148"
    });
  });

  let connectUrl = "";
  await page.route(/https:\/\/solflare\.com\/ul\/v1\/connect\?/, async (route) => {
    connectUrl = route.request().url();
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Solflare handoff intercepted</title>"
    });
  });

  await page.goto("/auth");
  const appOrigin = new URL(page.url()).origin;

  const connectButton = page.getByRole("button", {
    name: "Connect with Solflare"
  });
  await expect(connectButton).toBeVisible();

  const backpackButton = page.getByRole("button", {
    name: "Backpack unavailable on Devnet"
  });
  await expect(backpackButton).toBeDisabled();
  await expect(page.locator(".auth-mobile-note")).toContainText(
    "Backpack's published connection options do not list Devnet"
  );

  await connectButton.click();
  await expect.poll(() => connectUrl).not.toBe("");

  const connect = new URL(connectUrl);
  const redirect = new URL(connect.searchParams.get("redirect_link")!);

  expect(connect.origin).toBe("https://solflare.com");
  expect(connect.pathname).toBe("/ul/v1/connect");
  expect(connect.searchParams.get("app_url")).toBe(
    new URL("/", appOrigin).toString()
  );
  expect(connect.searchParams.get("cluster")).toBe("devnet");
  expect(connect.searchParams.get("dapp_encryption_public_key")).toMatch(
    /^[1-9A-HJ-NP-Za-km-z]{32,44}$/
  );
  expect(redirect.origin).toBe(appOrigin);
  expect(redirect.pathname).toBe("/auth");
  expect(redirect.searchParams.get("wallet_provider")).toBe("solflare");
  expect(redirect.searchParams.get("wallet_action")).toBe("connect");
  expect(redirect.searchParams.get("wallet_state")).toMatch(/^[a-f0-9]{48}$/);
});

test("a browser without a supported desktop extension gets the separate wallet-app path", async ({
  page
}) => {
  await page.goto("/auth");

  await expect(
    page.getByRole("button", { name: "Connect with Solflare" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Backpack unavailable on Devnet" })
  ).toBeDisabled();
  await expect(page.locator(".auth-card__header")).toContainText(
    "mobile wallet"
  );
});
