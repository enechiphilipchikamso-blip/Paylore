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
  await expect(page.getByRole("button", { name: "Connect with Backpack" })).toBeEnabled();
  await expect(page.locator(".auth-card")).toHaveCount(1);
  await expect(page.locator(".auth-card__header h2")).toHaveCount(1);
  await expect(page.locator(".wallet-chooser")).toHaveCount(1);
  await expect(page.locator(".wallet-app-links")).toHaveCount(0);
  await expect(page.locator(".wallet-choice")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Refresh wallet list" })).toBeEnabled();

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

test("a browser without an injected provider keeps the same sign-in page", async ({
  page
}) => {
  await page.goto("/auth");

  await expect(page.getByRole("button", { name: "Connect with Solflare" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Connect with Backpack" })).toBeEnabled();
  await expect(page.locator(".auth-card")).toHaveCount(1);
  await expect(page.locator(".auth-card__header h2")).toHaveCount(1);
  await expect(page.locator(".wallet-chooser")).toHaveCount(1);
  await expect(page.locator(".wallet-app-links")).toHaveCount(0);
  await expect(page.locator(".wallet-choice")).toHaveCount(4);
  await expect(page.getByRole("button", { name: "Refresh wallet list" })).toBeEnabled();
});


test("Backpack remains in the unified chooser when its optional deep-link route is off", async ({
  page
}) => {
  await page.goto("/auth");
  const backpackButton = page.getByRole("button", { name: "Connect with Backpack" });
  await expect(backpackButton).toBeEnabled();
  await expect(page.locator(".wallet-chooser")).toHaveCount(1);
  await expect(page.locator(".wallet-choice__icon--muted")).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Refresh wallet list" })).toBeEnabled();
  await backpackButton.click();
  await expect(page.getByRole("alert")).toContainText(
    "Backpack could not connect in this browser. Open Paylore in the Backpack app browser or connect with the Backpack browser extension."
  );
});


test("desktop browser uses the same Solflare row for the connection fallback", async ({
  page
}) => {
  let connectUrl = "";
  await page.route(/https:\/\/solflare\.com\/ul\/v1\/connect\?/, async (route) => {
    connectUrl = route.request().url();
    await route.fulfill({
      status: 200,
      contentType: "text/html",
      body: "<!doctype html><title>Solflare handoff intercepted</title>"
    });
  });

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/auth");
  const appOrigin = new URL(page.url()).origin;
  await expect(page.getByRole("button", { name: "Refresh wallet list" })).toBeEnabled();
  await expect(page.locator(".wallet-chooser")).toHaveCount(1);
  await expect(page.locator(".wallet-app-links")).toHaveCount(0);
  await page.getByRole("button", { name: "Connect with Solflare" }).click();
  await expect.poll(() => connectUrl).not.toBe("");
  const connect = new URL(connectUrl);
  expect(connect.searchParams.get("app_url")).toBe(new URL("/", appOrigin).toString());
});
