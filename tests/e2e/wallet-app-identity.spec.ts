import {
  expect,
  test
} from "@playwright/test";

test("wallet-facing page metadata names Paylore and advertises the canonical icons", async ({
  page
}) => {
  await page.goto("/");

  await expect(page).toHaveTitle("Paylore | Private on-chain payroll");
  await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
    "content",
    "Paylore | Private on-chain payroll"
  );
  await expect(page.locator('meta[property="og:site_name"]')).toHaveAttribute(
    "content",
    "Paylore"
  );
  await expect(page.locator('meta[name="application-name"]')).toHaveAttribute(
    "content",
    "Paylore"
  );

  const resolvePath = async (selector: string) => {
    const href = await page.locator(selector).getAttribute("href");
    expect(href).toBeTruthy();
    return new URL(href!, page.url()).pathname;
  };

  expect(
    await resolvePath('link[rel="apple-touch-icon"]')
  ).toBe("/apple-touch-icon.png");
  expect(
    await resolvePath('link[rel="shortcut icon"]')
  ).toBe("/favicon.ico");
  expect(
    await resolvePath('link[rel="icon"][type="image/png"][sizes="192x192"]')
  ).toBe("/icons/paylore-192x192.png");
  expect(
    await resolvePath('link[rel="manifest"]')
  ).toBe("/manifest.webmanifest");
});

test("wallet identity icon and manifest URLs are public, direct, and correctly typed", async ({
  request
}) => {
  const assets = [
    { path: "/apple-touch-icon.png", type: "image/png" },
    { path: "/favicon.ico", types: ["image/x-icon", "image/vnd.microsoft.icon"] },
    { path: "/favicon.svg", type: "image/svg+xml" },
    { path: "/icons/paylore-180x180.png", type: "image/png" },
    { path: "/icons/paylore-192x192.png", type: "image/png" },
    { path: "/icons/paylore-512x512.png", type: "image/png" },
    { path: "/manifest.webmanifest", type: "application/manifest+json" }
  ];

  for (const asset of assets) {
    const response = await request.get(asset.path, { maxRedirects: 0 });
    expect(response.status(), asset.path).toBe(200);
    expect(new URL(response.url()).pathname, asset.path).toBe(asset.path);
    const contentType = response.headers()["content-type"].split(";")[0];
    if ("types" in asset) {
      expect(asset.types).toContain(contentType);
    } else {
      expect(contentType, asset.path).toBe(asset.type);
    }

    if (asset.path.endsWith(".png")) {
      const body = await response.body();
      expect(body.subarray(0, 8)).toEqual(
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
      );
    }
  }

  const manifestResponse = await request.get("/manifest.webmanifest", {
    maxRedirects: 0
  });
  const manifest = await manifestResponse.json();
  expect(manifest.name).toBe("Paylore");
  expect(manifest.icons).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        src: "/icons/paylore-192x192.png",
        sizes: "192x192",
        type: "image/png"
      }),
      expect.objectContaining({
        src: "/icons/paylore-512x512.png",
        sizes: "512x512",
        type: "image/png"
      })
    ])
  );
});
