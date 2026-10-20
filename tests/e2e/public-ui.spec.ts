import {
  expect,
  test
} from "@playwright/test";

test("compact interface scale applies across public and app routes", async ({
  page
}) => {
  for (const route of ["/", "/auth", "/app"]) {
    await page.setViewportSize({
      width: 1440,
      height: 900
    });
    await page.goto(route);

    const sizes = await page.evaluate(() => ({
      root: getComputedStyle(document.documentElement).fontSize,
      body: getComputedStyle(document.body).fontSize,
      menuIcon: getComputedStyle(
        document.querySelector(".site-menu__icon")!
      ).width,
      themeIcon: getComputedStyle(
        document.querySelector(".theme-toggle svg")!
      ).width,
      container: getComputedStyle(
        document.querySelector(".site-container")!
      ).width
    }));

    expect(sizes.root).toBe("14px");
    expect(sizes.body).toBe("14px");
    expect(sizes.menuIcon).toBe("14px");
    expect(sizes.themeIcon).toBe("18px");
    expect(sizes.container).toBe("1008px");
  }
});

test("Geist Sans is used for the UI and Geist Mono aligns financial values", async ({
  page
}) => {
  await page.goto("/pricing");
  await page.evaluate(async () => {
    await document.fonts.ready;
  });

  const fonts = await page.evaluate(() => {
    const sans = getComputedStyle(document.body).fontFamily;
    const mono = getComputedStyle(
      document.querySelector(".price-card__amount")!
    );
    const code = document.createElement("code");
    const employeeId = document.createElement("span");
    employeeId.className = "employee-id";
    document.body.append(code, employeeId);
    const codeFont = getComputedStyle(code).fontFamily;
    const employeeIdFont = getComputedStyle(employeeId).fontFamily;
    code.remove();
    employeeId.remove();

    return {
      sans,
      declaredSans: getComputedStyle(document.documentElement)
        .getPropertyValue("--font-geist-sans")
        .trim(),
      amountFont: mono.fontFamily,
      declaredMono: getComputedStyle(document.documentElement)
        .getPropertyValue("--font-geist-mono")
        .trim(),
      amountNumericVariant: mono.fontVariantNumeric,
      amountNumericFeatures: mono.fontFeatureSettings,
      fontsLoaded: document.fonts.check("14px Geist") &&
        document.fonts.check('14px "Geist Mono"'),
      fontFaces: [...document.fonts].map(({ family, status }) => ({
        family,
        status
      })),
      codeFont,
      employeeIdFont
    };
  });

  const families = (value: string) =>
    value
      .split(",")
      .map((family) => family.trim().replaceAll('"', ""));
  expect(families(fonts.sans)).toEqual(families(fonts.declaredSans));
  expect(families(fonts.amountFont)).toEqual(families(fonts.declaredMono));
  expect(families(fonts.codeFont)).toEqual(families(fonts.declaredMono));
  expect(families(fonts.employeeIdFont)).toEqual(families(fonts.declaredMono));
  expect(fonts.fontsLoaded, JSON.stringify(fonts.fontFaces)).toBe(true);
  expect(fonts.amountNumericVariant).toContain("tabular-nums");
  expect(fonts.amountNumericFeatures).toContain("tnum");
});

test("workspace loading action keeps a circular spinner and faded button style", async ({
  page
}) => {
  await page.goto("/");
  const loadingAction = await page.evaluate(() => {
    const link = document.createElement("a");
    link.className = "button";
    link.setAttribute("aria-busy", "true");
    link.innerHTML =
      '<span class="open-workspace-link__content"><span class="loading-indicator__icon" aria-hidden="true"></span>Opening Workspace...</span>';
    document.body.append(link);
    const icon = link.querySelector(".loading-indicator__icon")!;
    const initial = {
      width: getComputedStyle(icon).width,
      height: getComputedStyle(icon).height,
      display: getComputedStyle(icon).display,
      flexBasis: getComputedStyle(icon).flexBasis,
      borderRadius: getComputedStyle(icon).borderRadius,
      opacity: getComputedStyle(link).opacity
    };
    link.remove();
    return initial;
  });

  expect(loadingAction.width).toBe("14px");
  expect(loadingAction.height).toBe("14px");
  expect(loadingAction.display).toBe("block");
  expect(loadingAction.flexBasis).toBe("14px");
  expect(loadingAction.borderRadius).toBe("50%");
  expect(loadingAction.opacity).toBe("0.58");
});

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

test("mobile menu browser-restored open state does not cause hydration errors", async ({
  page
}) => {
  await page.addInitScript(() => {
    const observer = new MutationObserver(() => {
      const menu = document.querySelector<HTMLDetailsElement>(".site-menu");
      if (!menu) return;
      menu.open = true;
      observer.disconnect();
    });
    observer.observe(document, { childList: true, subtree: true });
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

  await expect(page.locator(".site-menu")).toHaveAttribute("open", "");
  await expect(
    page.getByRole("navigation", { name: "Site navigation" })
  ).toBeVisible();
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
  const menuLabelSize = await menu
    .locator("summary")
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  const menuIconWidth = await menu
    .locator(".site-menu__icon")
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).width));
  expect(menuLabelSize).toBeLessThan(16);
  expect(menuIconWidth).toBeLessThan(16);

  await menu.locator("summary").click();

  const panel = menu.locator("nav");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("listitem")).toHaveCount(8);
  const navigationLinkSize = await panel
    .getByRole("link")
    .first()
    .evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
  expect(navigationLinkSize).toBeLessThan(16);

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

test("site menu marks the current page with a blended accent line", async ({
  page
}) => {
  await page.goto("/product");
  await page.locator(".site-menu summary").click();

  const currentLink = page
    .getByRole("navigation", { name: "Site navigation" })
    .getByRole("link", { name: "Product" });

  await expect(currentLink).toHaveAttribute("aria-current", "page");
  await expect(
    page
      .getByRole("navigation", { name: "Site navigation" })
      .getByRole("link", { name: "Pricing" })
  ).not.toHaveAttribute("aria-current", "page");
});

test("legal pages show the approved effective date", async ({
  page
}) => {
  await page.goto("/terms");
  await expect(
    page.getByText("Effective date: October 12, 2026", { exact: true })
  ).toBeVisible();
  await expect(
    page.locator(".legal-copy").getByText(
      "These Terms of Service are effective as of October 12, 2026.",
      { exact: true }
    )
  ).toBeVisible();
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    "These Terms of Service are effective as of October 12, 2026."
  );

  await page.goto("/privacy");
  await expect(
    page.getByText("Effective date: October 12, 2026", { exact: false })
  ).toBeVisible();
  await expect(
    page.locator(".legal-copy").getByText(
      "The Paylore Privacy Policy is effective as of October 12, 2026.",
      { exact: true }
    )
  ).toBeVisible();
  await expect(page.locator('meta[name="description"]')).toHaveAttribute(
    "content",
    new RegExp("^The Paylore Privacy Policy is effective")
  );
});
