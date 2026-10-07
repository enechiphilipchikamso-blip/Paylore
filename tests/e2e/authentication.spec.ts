import {
  expect,
  test
} from "@playwright/test";

const SUPPORTED_WALLETS = [
  "Phantom",
  "Solflare",
  "Backpack",
  "Jupiter"
];

test.describe(
  "authentication boundary",
  () => {
    test(
      "authentication entry uses the product wording",
      async ({ page }) => {
        await page.goto("/auth");

        await expect(
          page.getByText(
            "SECURE ENTRY",
            { exact: true }
          )
        ).toBeVisible();

        await expect(
          page.getByRole("heading", {
            name: "Sign in to Paylore"
          })
        ).toHaveCount(2);

        await expect(
          page.getByText(
            "No wallet is connected",
            { exact: true }
          )
        ).toBeVisible();

        await expect(
          page.getByRole("button", {
            name: "Connect wallet"
          })
        ).toBeVisible();

        await expect(
          page.getByText(
            "Signing in is an authentication action. It does not send payroll funds.",
            { exact: true }
          )
        ).toBeVisible();

        await expect(
          page.locator(
            'meta[name="robots"]'
          )
        ).toHaveAttribute(
          "content",
          /noindex/
        );
      }
    );

    test(
      "wallet chooser is limited to the four supported wallets",
      async ({ page }) => {
        await page.goto("/auth");

        await page.getByRole(
          "button",
          {
            name: "Connect wallet"
          }
        ).click();

        const chooser =
          page.locator(
            ".wallet-chooser"
          );

        await expect(
          chooser
        ).toBeVisible();

        await expect(
          chooser.getByText(
            "Choose a wallet available in this browser.",
            { exact: true }
          )
        ).toBeVisible();

        for (
          const wallet of
          SUPPORTED_WALLETS
        ) {
          await expect(
            chooser.getByText(
              wallet,
              { exact: true }
            )
          ).toBeVisible();
        }

        await expect(
          chooser.getByText(
            "More wallets",
            { exact: true }
          )
        ).toHaveCount(0);
      }
    );

    test(
      "wallet connection remains available on mobile viewports",
      async ({ page }) => {
        await page.setViewportSize(
          {
            width: 390,
            height: 844
          }
        );

        await page.goto("/auth");

        const connectButton =
          page.getByRole(
            "button",
            {
              name:
                "Connect wallet"
            }
          );

        await expect(
          connectButton
        ).toBeVisible();

        const mobileButtonWidth =
          await connectButton.evaluate(
            (button) =>
              button.getBoundingClientRect()
                .width
          );

        expect(
          mobileButtonWidth
        ).toBeGreaterThan(0);
        expect(
          mobileButtonWidth
        ).toBeLessThanOrEqual(320);

        const mobileButtonCenter =
          await connectButton.evaluate(
            (button) => {
              const rect =
                button.getBoundingClientRect();
              const container =
                button.closest(
                  ".auth-card"
                )?.getBoundingClientRect();

              return {
                button:
                  rect.left + rect.width / 2,
                container:
                  container
                    ? container.left +
                      container.width / 2
                    : Number.NaN
              };
            }
          );

        expect(
          mobileButtonCenter.button
        ).toBeCloseTo(
          mobileButtonCenter.container,
          0
        );

        await connectButton.click();

        const chooser =
          page.locator(
            ".wallet-chooser"
          );

        await expect(
          chooser
        ).toBeVisible();

        for (
          const wallet of
          SUPPORTED_WALLETS
        ) {
          await expect(
            chooser.getByText(
              wallet,
              { exact: true }
            )
          ).toBeVisible();
        }
      }
    );

    test(
      "connect action stays capped on wide viewports",
      async ({ page }) => {
        await page.setViewportSize({
          width: 1440,
          height: 1000
        });

        await page.goto("/auth");

        const connectButton =
          page.getByRole(
            "button",
            {
              name: "Connect wallet"
            }
          );

        const buttonWidth =
          await connectButton.evaluate(
            (button) =>
              button.getBoundingClientRect()
                .width
          );

        expect(
          buttonWidth
        ).toBeLessThanOrEqual(320);

        const centered =
          await connectButton.evaluate(
            (button) => {
              const rect =
                button.getBoundingClientRect();
              const container =
                button.closest(
                  ".auth-card"
                )?.getBoundingClientRect();

              return container
                ? Math.abs(
                    rect.left +
                      rect.width / 2 -
                      (container.left +
                        container.width / 2)
                  ) <= 1
                : false;
            }
          );

        expect(centered).toBe(true);
      }
    );

    test(
      "wallet chooser displays local wallet logos without availability labels",
      async ({ page }) => {
        await page.goto("/auth");

        await page.getByRole(
          "button",
          {
            name: "Connect wallet"
          }
        ).click();

        const chooser =
          page.locator(
            ".wallet-chooser"
          );

        const walletImages =
          chooser.locator(
            ".wallet-choice__icon img"
          );

        await expect(
          walletImages
        ).toHaveCount(4);

        await expect
          .poll(() =>
            walletImages.evaluateAll(
              (images) =>
                images.every(
                  (image) =>
                    image.complete &&
                    image.naturalWidth > 0
                )
            )
          )
          .toBe(true);

        for (
          const icon of [
            "phantom.svg",
            "solflare.svg",
            "backpack.png",
            "jupiter.svg"
          ]
        ) {
          await expect(
            chooser.locator(
              `.wallet-choice__icon img[src$="${icon}"]`
            )
          ).toHaveCount(1);
        }

        await expect(
          chooser.getByText(
            "Available",
            { exact: true }
          )
        ).toHaveCount(0);
      }
    );

    test(
      "protected workspace gateway redirects unauthenticated users",
      async ({ page }) => {
        await page.goto("/app");

        await expect(
          page
        ).toHaveURL(
          /\/auth\?next=%2Fapp$/
        );
      }
    );

    test(
      "workspace creation fails closed without a session",
      async ({ request }) => {
        const response =
          await request.post(
            "/api/workspaces",
            {
              headers: {
                origin:
                  "http://localhost:3100",
                "content-type":
                  "application/json"
              },
              data: {
                name:
                  "Unauthorized Workspace"
              }
            }
          );

        expect(
          response.status()
        ).toBe(401);

        const body =
          await response.json();

        expect(body.error).toBe(
          "authentication_required"
        );
      }
    );

    test(
      "state-changing auth endpoints reject cross-origin requests",
      async ({ request }) => {
        const response =
          await request.post(
            "/api/auth/challenge",
            {
              headers: {
                origin:
                  "https://evil.example",
                "content-type":
                  "application/json"
              },
              data: {
                walletAddress:
                  "11111111111111111111111111111111"
              }
            }
          );

        expect(
          response.status()
        ).toBe(403);
      }
    );

    test(
      "session endpoint never returns a raw session token",
      async ({ request }) => {
        const response =
          await request.get(
            "/api/auth/session"
          );

        expect(
          [200, 401].includes(
            response.status()
          )
        ).toBe(true);

        const body =
          await response.json();

        expect(
          body
        ).not.toHaveProperty(
          "token"
        );

        expect(
          body
        ).not.toHaveProperty(
          "sessionToken"
        );

        expect(
          body
        ).not.toHaveProperty(
          "cookie"
        );
      }
    );

    test(
      "malformed wallet proofs are rejected with authentication_failed",
      async ({ page }) => {
        await page.goto("/auth");

        const result =
          await page.evaluate(
            async () => {
              const response =
                await fetch(
                  "/api/auth/verify",
                  {
                    method: "POST",
                    headers: {
                      "content-type":
                        "application/json"
                    },
                    credentials:
                      "same-origin",
                    body: JSON.stringify({})
                  }
                );

              return {
                status:
                  response.status,
                body:
                  await response.json()
              };
            }
          );

        expect(result.status).toBe(401);
        expect(result.body).toEqual({
          error:
            "authentication_failed"
        });
      }
    );
  }
);