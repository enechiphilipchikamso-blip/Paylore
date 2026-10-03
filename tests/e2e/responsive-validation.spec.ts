import {
  expect,
  test,
  type Locator
} from "@playwright/test";

const viewports = [
  { width: 390, height: 844 },
  { width: 768, height: 1024 },
  { width: 1024, height: 768 },
  { width: 1440, height: 900 }
];

async function movePointerTo(page: import("@playwright/test").Page, locator: Locator) {
  const box = await locator.boundingBox();

  expect(box).not.toBeNull();

  if (!box) {
    return;
  }

  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(350);
}

test("public page remains usable at target responsive viewport sizes", async ({
  page
}, testInfo) => {
  test.setTimeout(180_000);

  await page.addInitScript(() => {
    const installMarkers = () => {
      const hud = document.createElement("div");
      hud.id = "playwright-visual-status";
      hud.style.cssText =
        "position:fixed;z-index:2147483646;top:6px;left:50%;transform:translateX(-50%);max-width:calc(100vw - 12px);padding:5px 9px;border:1px solid #fff;border-radius:999px;background:#102033;color:#fff;font:600 12px/1.2 ui-monospace,monospace;pointer-events:none;white-space:nowrap;box-shadow:0 2px 8px #0006";
      hud.textContent = "PLAYWRIGHT RESPONSIVE VALIDATION";
      document.body.append(hud);

      const pointer = document.createElement("div");
      pointer.id = "playwright-visual-pointer";
      pointer.style.cssText =
        "position:fixed;z-index:2147483647;top:0;left:0;width:30px;height:38px;pointer-events:none;filter:drop-shadow(0 1px 2px #000);";
      pointer.innerHTML =
        '<svg width="30" height="38" viewBox="0 0 30 38" aria-hidden="true"><path d="M2 1v27l7-7 6 12 5-3-6-11 11-1z" fill="#ff2d55" stroke="#fff" stroke-width="2" stroke-linejoin="round"/></svg>';
      document.body.append(pointer);

      window.addEventListener("mousemove", (event) => {
        pointer.style.transform = `translate(${event.clientX}px, ${event.clientY}px)`;
      });
    };

    if (document.readyState === "loading") {
      document.addEventListener("DOMContentLoaded", installMarkers, {
        once: true
      });
    } else {
      installMarkers();
    }
  });

  for (const viewport of viewports) {
    await page.setViewportSize(viewport);
    await page.goto("/");

    const status = `${viewport.width} x ${viewport.height}`;
    await page.evaluate((text) => {
      const hud = document.querySelector("#playwright-visual-status");
      if (hud) hud.textContent = `PLAYWRIGHT • ${text} • START`;
    }, status);

    const header = page.locator(".site-header");
    const brand = header.getByRole("link", { name: "Paylore home" }).first();
    await expect(header).toBeVisible();
    await expect(brand).toBeVisible();
    await movePointerTo(page, brand);

    if (viewport.width <= 896) {
      const mobileNav = page.locator("details.mobile-nav");
      const menu = mobileNav.locator("summary");
      await expect(menu).toBeVisible();
      await movePointerTo(page, menu);
      await menu.click();

      const productLink = mobileNav.getByRole("link", { name: "Product" });
      await expect(productLink).toBeVisible();
      await movePointerTo(page, productLink);
      await productLink.click();
    } else {
      const productLink = page
        .locator(".desktop-nav")
        .getByRole("link", { name: "Product" });
      await expect(productLink).toBeVisible();
      await movePointerTo(page, productLink);
      await productLink.click();
    }

    await expect(page).toHaveURL(/\/product$/);
    await page.goBack();
    await expect(page).toHaveURL(/\/$/);

    const theme = page.getByRole("combobox", { name: "Theme" });
    await expect(theme).toBeVisible();
    await expect(theme).toHaveAttribute("data-theme-ready", "true");
    await movePointerTo(page, theme);
    await theme.selectOption("dark");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await theme.selectOption("light");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await theme.selectOption("system");
    await expect(page.locator("html")).not.toHaveAttribute("data-theme");

    const documentWidth = await page.evaluate(
      () => document.documentElement.scrollWidth
    );
    expect(documentWidth, `horizontal overflow at ${status}`).toBeLessThanOrEqual(
      viewport.width
    );

    const hero = page.locator(".hero");
    const firstCards = page.locator(".card-grid").first();
    const [heroBox, cardBox] = await Promise.all([
      hero.boundingBox(),
      firstCards.boundingBox()
    ]);
    expect(heroBox).not.toBeNull();
    expect(cardBox).not.toBeNull();
    if (heroBox && cardBox) {
      const overlaps =
        heroBox.x < cardBox.x + cardBox.width &&
        heroBox.x + heroBox.width > cardBox.x &&
        heroBox.y < cardBox.y + cardBox.height &&
        heroBox.y + heroBox.height > cardBox.y;
      expect(overlaps, `hero overlaps feature cards at ${status}`).toBe(false);
    }

    const cardColumns = await firstCards.evaluate((grid) =>
      getComputedStyle(grid).gridTemplateColumns
        .trim()
        .split(/\s+/)
        .filter(Boolean)
    );
    expect(
      cardColumns.length,
      `unexpected card reflow at ${status}`
    ).toBe(viewport.width <= 896 ? 1 : 3);

    await page.evaluate((text) => {
      const hud = document.querySelector("#playwright-visual-status");
      if (hud) hud.textContent = `PLAYWRIGHT • ${text} • KEYBOARD FOCUS`;
    }, status);
    await page.keyboard.press("Tab");
    const focused = page.locator(":focus");
    await expect(focused).toBeVisible();
    const focusStyle = await focused.evaluate((element) => {
      const style = getComputedStyle(element);
      return {
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        rect: element.getBoundingClientRect().toJSON()
      };
    });
    expect(focusStyle.outlineStyle).not.toBe("none");
    expect(parseFloat(focusStyle.outlineWidth)).toBeGreaterThan(0);
    expect(focusStyle.rect.x).toBeGreaterThanOrEqual(0);
    expect(focusStyle.rect.right).toBeLessThanOrEqual(viewport.width);
    await movePointerTo(page, focused);

    const screenshotPath = testInfo.outputPath(
      `responsive-${viewport.width}x${viewport.height}.png`
    );
    await page.evaluate((text) => {
      const hud = document.querySelector("#playwright-visual-status");
      if (hud) hud.textContent = `PLAYWRIGHT • ${text} • FOCUS VISIBLE`;
    }, status);
    await page.screenshot({ path: screenshotPath, fullPage: true });
    await testInfo.attach(`responsive-${viewport.width}x${viewport.height}`, {
      path: screenshotPath,
      contentType: "image/png"
    });

    const footer = page.locator(".site-footer");
    await footer.scrollIntoViewIfNeeded();
    await expect(footer).toBeVisible();
    await expect(footer.locator(".site-footer__description")).toBeVisible();
    const footerLinks = footer.getByRole("navigation", {
      name: "Footer navigation"
    });
    await expect(footerLinks).toBeVisible();
    for (const label of ["Terms", "Privacy", "Security"]) {
      await expect(
        footerLinks.getByRole("link", { name: label })
      ).toBeVisible();
    }
    await movePointerTo(page, footerLinks);
    await page.evaluate((text) => {
      const hud = document.querySelector("#playwright-visual-status");
      if (hud) hud.textContent = `PLAYWRIGHT • ${text} • ALL CHECKS PASS`;
    }, status);

    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(400);
  }
});
