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
    page.getByRole("heading", {
      name: "Private payroll without giving up clear operational control"
    })
    ).toBeVisible();
  });

  test("theme icon cycles through light, dark, and system", async ({
    page
  }) => {
    await page.goto("/");

    const theme = page.locator(".theme-toggle");
    await expect(theme).toBeVisible();
    await expect(theme.locator("svg")).toHaveAttribute(
      "data-theme-icon",
      "system"
    );

    await theme.click();
    await expect(theme.locator("svg")).toHaveAttribute(
      "data-theme-icon",
      "light"
    );
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    await theme.click();
    await expect(theme.locator("svg")).toHaveAttribute(
      "data-theme-icon",
      "dark"
    );
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await page.reload();

    const reloadedTheme = page.locator(".theme-toggle");
    await expect(reloadedTheme.locator("svg")).toHaveAttribute(
      "data-theme-icon",
      "dark"
    );
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

    await reloadedTheme.click();
    await expect(reloadedTheme.locator("svg")).toHaveAttribute(
      "data-theme-icon",
      "system"
    );
    await expect(page.locator("html")).not.toHaveAttribute("data-theme");
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

    expect(ogTitle).toBe("Paylore");

    const twitterTitle = await page
      .locator('meta[name="twitter:title"]')
      .getAttribute("content");
    expect(twitterTitle).toContain("Pricing");

    const twitterCard = await page
      .locator('meta[name="twitter:card"]')
      .getAttribute("content");

    expect(twitterCard).toBe("summary_large_image");
  });

  test("manifest and icon resources load", async ({ page, request }) => {
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
      "/favicon.svg",
      "/apple-touch-icon.png",
      "/icons/favicon.svg",
      "/icons/favicon-180x180.png",
      "/icons/paylore-192x192.png",
      "/icons/paylore-512x512.png",
      "/icons/paylore-180x180.png"
    ]) {
      const asset = await request.get(assetPath);
      expect(asset.ok()).toBeTruthy();
    }

    const favicon = await request.get("/favicon.svg");
    const faviconSvg = await favicon.text();
    expect(faviconSvg).toContain('fill="#f7f9fc"');
    expect(faviconSvg).toContain('transform="translate(0 -18)"');

    const brandLogo = await request.get("/brand/paylore.svg");
    expect(await brandLogo.text()).toContain(
      'transform="translate(0 -18)"'
    );

    await page.goto("/");

    const svgIconHref = await page
      .locator('link[rel="icon"][type="image/svg+xml"]')
      .getAttribute("href");
    expect(new URL(svgIconHref!, page.url()).pathname).toBe("/favicon.svg");

    await expect(page.locator('meta[name="application-name"]')).toHaveAttribute(
      "content",
      "Paylore"
    );
    await expect(page.locator('link[rel="manifest"]')).toHaveAttribute(
      "href",
      "/manifest.webmanifest"
    );

    const shortcutIconHref = await page
      .locator('link[rel="shortcut icon"]')
      .getAttribute("href");
    expect(new URL(shortcutIconHref!, page.url()).pathname).toBe("/favicon.ico");

    const pngIconHref = await page
      .locator('link[rel="icon"][type="image/png"][sizes="192x192"]')
      .getAttribute("href");
    expect(new URL(pngIconHref!, page.url()).pathname).toBe(
      "/icons/paylore-192x192.png"
    );

    const appleIconHref = await page
      .locator('link[rel="apple-touch-icon"]')
      .getAttribute("href");
    expect(new URL(appleIconHref!, page.url()).pathname).toBe(
      "/apple-touch-icon.png"
    );
  });

  test("robots and sitemap contain public routes only", async ({ page }) => {
    const robots = await page.goto("/robots.txt");
    if (!robots) {
      throw new Error("No response received for /robots.txt");
    }
    expect(robots.ok()).toBeTruthy();

    const robotsText = await robots.text();

    expect(robotsText).toContain("Disallow: /api/");
    expect(robotsText).toContain("Sitemap:");

    const sitemap = await page.goto("/sitemap.xml");
    if (!sitemap) {
      throw new Error("No response received for /sitemap.xml");
    }
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
    page
  }) => {
    const response = await page.goto("/api/health");
    if (!response) {
      throw new Error("No response received for /api/health");
    }

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