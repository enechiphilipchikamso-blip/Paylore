import {
  expect,
  test
} from "@playwright/test";

test("theme preference hydrates cleanly and cycles through all modes", async ({
  page
}) => {
  await page.emulateMedia({ colorScheme: "dark" });
  await page.addInitScript(() => {
    localStorage.setItem("paylore-theme", "dark");
  });

  const hydrationErrors: string[] = [];
  page.on("console", (message) => {
    if (
      message.type() === "error" &&
      /hydration|hydrated|server rendered html/i.test(message.text())
    ) {
      hydrationErrors.push(message.text());
    }
  });

  await page.goto("/");

  const toggle = page.getByRole("button", {
    name: "Theme: dark. Activate to switch to system."
  });
  await expect(toggle).toBeVisible();
  await expect(toggle.locator("svg")).toHaveAttribute(
    "data-theme-icon",
    "dark"
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");

  await toggle.click();
  const systemToggle = page.getByRole("button", {
    name: "Theme: system. Activate to switch to light."
  });
  await expect(systemToggle.locator("svg")).toHaveAttribute(
    "data-theme-icon",
    "system"
  );
  await expect(page.locator("html")).not.toHaveAttribute("data-theme");
  await expect(page.locator("body")).toHaveCSS(
    "background-color",
    "rgb(8, 17, 29)"
  );

  await systemToggle.click();
  const lightToggle = page.getByRole("button", {
    name: "Theme: light. Activate to switch to dark."
  });
  await expect(lightToggle.locator("svg")).toHaveAttribute(
    "data-theme-icon",
    "light"
  );
  await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

  await lightToggle.click();
  const darkToggle = page.getByRole("button", {
    name: "Theme: dark. Activate to switch to system."
  });
  await expect(darkToggle.locator("svg")).toHaveAttribute(
    "data-theme-icon",
    "dark"
  );

  expect(hydrationErrors).toEqual([]);
});

test("mobile menu stays inside an opaque content-height dropdown", async ({
  page
}) => {
  await page.setViewportSize({
    width: 390,
    height: 844
  });
  await page.goto("/");

  const menu = page.locator(".site-menu");
  await menu.locator("summary").click();

  const panel = menu.locator("nav");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("listitem")).toHaveCount(8);

  const panelBounds = await panel.boundingBox();
  expect(panelBounds).not.toBeNull();
  if (!panelBounds) {
    return;
  }

  const panelStyle = await panel.evaluate((element) => {
    const style = getComputedStyle(element);
    return {
      position: style.position,
      backgroundColor: style.backgroundColor,
      height: element.getBoundingClientRect().height,
      scrollHeight: element.scrollHeight,
      maxHeight: Number.parseFloat(style.maxHeight)
    };
  });

  expect(panelStyle.position).toBe("absolute");
  expect(panelStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(panelBounds.width).toBeLessThan(390);
  expect(panelBounds.height).toBeLessThan(844);
  expect(panelStyle.height).toBeLessThanOrEqual(panelStyle.maxHeight);
  expect(panelBounds.x).toBeGreaterThanOrEqual(0);
  expect(panelBounds.x + panelBounds.width).toBeLessThanOrEqual(390);

  const linkBounds = await panel.getByRole("link").evaluateAll((links) =>
    links.map((link) => {
      const rect = link.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom
      };
    })
  );

  for (const bounds of linkBounds) {
    expect(bounds.left).toBeGreaterThanOrEqual(panelBounds.x);
    expect(bounds.right).toBeLessThanOrEqual(panelBounds.x + panelBounds.width);
    expect(bounds.top).toBeGreaterThanOrEqual(panelBounds.y);
    expect(bounds.bottom).toBeLessThanOrEqual(
      panelBounds.y + panelBounds.height
    );
  }
});
