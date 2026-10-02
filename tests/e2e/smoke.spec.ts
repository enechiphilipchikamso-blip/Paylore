import {
  expect,
  test
} from "@playwright/test";

const publicRoutes = [
  "/",
  "/product",
  "/pricing",
  "/docs",
  "/terms",
  "/privacy",
  "/security"
];

test.describe("public experience", () => {
  test("all public routes render", async ({ page }) => {
    for (const route of publicRoutes) {
      await page.goto(route);

      await expect(page.locator("main")).toBeVisible();
      await expect(page.locator("h1")).toHaveCount(1);
    }
  });

  test("homepage navigation reaches the product page", async ({
    page
  }) => {
    await page.goto("/");

    await page
      .getByRole("link", { name: "Product" })
      .first()
      .click();

    await expect(page).toHaveURL(/\/product$/);
    await expect(
      page.getByRole("heading", { name: "Private payroll on Solana" })
    ).toBeVisible();
  });

  test("theme selector supports light, dark, and system", async ({
    page
  }) => {
    await page.goto("/");

    const theme = page.getByRole("combobox", {
      name: "Theme"
    });

    await theme.selectOption("dark");

    await expect(theme).toHaveValue("dark");
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "dark"
    );

    await page.reload();

    await expect(theme).toHaveValue("dark");
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "dark"
    );

    await theme.selectOption("light");

    await expect(theme).toHaveValue("light");
    await expect(page.locator("html")).toHaveAttribute(
      "data-theme",
      "light"
    );

    await theme.selectOption("system");

    await expect(theme).toHaveValue("system");
    await expect(page.locator("html")).not.toHaveAttribute(
      "data-theme"
    );
  });

  test("mobile navigation is keyboard operable", async ({ page }) => {
    await page.setViewportSize({
      width: 390,
      height: 844
    });

    await page.goto("/");

    const mobileNav = page.locator("details.mobile-nav");
    const summary = mobileNav.locator("summary");

    await summary.focus();
    await expect(summary).toBeFocused();

    await summary.press("Enter");

    await expect(mobileNav).toHaveAttribute("open", "");

    await expect(
      mobileNav.getByRole("link", {
        name: "Pricing"
      })
    ).toBeVisible();
  });

  test("pricing metadata is present", async ({ page }) => {
    await page.goto("/pricing");

    await expect(page).toHaveTitle(/Pricing \| Paylore/);

    const description = await page
      .locator('meta[name="description"]')
      .getAttribute("content");

    expect(description).toBeTruthy();

    const ogTitle = await page
      .locator('meta[property="og:title"]')
      .getAttribute("content");

    expect(ogTitle).toContain("Pricing");

    const twitterCard = await page
      .locator('meta[name="twitter:card"]')
      .getAttribute("content");

    expect(twitterCard).toBe("summary_large_image");
  });

  test("manifest and icon resources load", async ({ request }) => {
    const manifest = await request.get(
      "/manifest.webmanifest"
    );

    expect(manifest.ok()).toBeTruthy();

    const manifestJson = await manifest.json();

    expect(manifestJson.name).toBe("Paylore");
    expect(manifestJson.short_name).toBe("Paylore");

    expect(
      manifestJson.icons.some(
        (icon: {
          sizes: string;
          type: string;
        }) =>
          icon.sizes === "192x192" &&
          icon.type === "image/png"
      )
    ).toBeTruthy();

    expect(
      manifestJson.icons.some(
        (icon: {
          sizes: string;
          type: string;
        }) =>
          icon.sizes === "512x512" &&
          icon.type === "image/png"
      )
    ).toBeTruthy();

    for (const assetPath of [
      "/brand/paylore.svg",
      "/brand/paylore.png",
      "/icons/paylore-192x192.png",
      "/icons/paylore-512x512.png",
      "/icons/paylore-180x180.png"
    ]) {
      const asset = await request.get(assetPath);
      expect(asset.ok()).toBeTruthy();
    }
  });

  test("robots and sitemap contain public routes only", async ({
    request
  }) => {
    const robots = await request.get("/robots.txt");
    expect(robots.ok()).toBeTruthy();

    const robotsText = await robots.text();

    expect(robotsText).toContain("Disallow: /api/");
    expect(robotsText).toContain("Sitemap:");

    const sitemap = await request.get("/sitemap.xml");
    expect(sitemap.ok()).toBeTruthy();

    const sitemapText = await sitemap.text();

    expect(sitemapText).toContain("/pricing");
    expect(sitemapText).toContain("/product");
    expect(sitemapText).toContain("/docs");
    expect(sitemapText).toContain("/terms");
    expect(sitemapText).toContain("/privacy");
    expect(sitemapText).toContain("/security");

    expect(sitemapText).not.toContain("/api/health");
    expect(sitemapText).not.toContain("/dashboard/");
    expect(sitemapText).not.toContain("/workspace/");
  });

  test("health endpoint retains the Batch 01 safe boundary", async ({
    request
  }) => {
    const response = await request.get("/api/health");

    expect([200, 503]).toContain(response.status());

    const body = await response.json();

    expect(body.service).toBe("paylore-web");
    expect(["ok", "error"]).toContain(body.status);

    expect(body).not.toHaveProperty("databaseUrl");
    expect(body).not.toHaveProperty("connectionString");
    expect(body).not.toHaveProperty("privateKey");
    expect(body).not.toHaveProperty("stack");
  });
});