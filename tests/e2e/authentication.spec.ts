import {
  expect,
  test,
  type Page
} from "@playwright/test";

const SUPPORTED_WALLETS = [
  "Phantom",
  "Solflare",
  "Backpack",
  "Jupiter"
];

async function registerWalletStandardMocks(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const account = {
      address: "11111111111111111111111111111111",
      publicKey: new Uint8Array(32),
      chains: ["solana:devnet"],
      features: [
        "standard:connect",
        "standard:disconnect",
        "solana:signMessage"
      ]
    };

    const wallets = [
      "Phantom",
      "Solflare",
      "Backpack",
      "Jupiter"
    ].map((name) => ({
      version: "1.0.0",
      name,
      icon: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p8sAAAAASUVORK5CYII=",
      chains: ["solana:devnet"],
      features: {
        "standard:connect": {
          version: "1.0.0",
          connect: async () => ({ accounts: [account] })
        },
        "standard:disconnect": {
          version: "1.0.0",
          disconnect: async () => undefined
        }
      },
      accounts: [account]
    }));

    window.addEventListener("wallet-standard:app-ready", (event) => {
      const api = (event as CustomEvent<{
        register: (...wallets: unknown[]) => void;
      }>).detail;
      api.register(...wallets);
    });
  });
}

test.describe(
  "authentication boundary",
  () => {
    test(
      "authentication entry uses the product wording",
      async ({ page }) => {
        await registerWalletStandardMocks(page);
        await page.goto("/auth");

        await expect(
          page.locator(".page-heading__description")
        ).toHaveText(
          "Connect one of the supported Solana wallets and sign the Paylore authentication request. This signature proves wallet control; it does not send payroll funds or a payroll transaction."
        );

        await expect(
          page.getByRole("heading", {
            name: "Sign in to Paylore"
          })
        ).toHaveCount(2);

        await expect(
          page.getByText(
            "Wallet not connected",
            { exact: true }
          )
        ).toBeVisible();

        await expect(
          page.getByRole("button", {
            name: "Refresh wallet list"
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
        await registerWalletStandardMocks(page);
        await page.goto("/auth");

        await page.getByRole(
          "button",
          {
            name: "Refresh wallet list"
          }
        ).click();

        const chooser =
          page.locator(
            ".wallet-standard-chooser"
          );

        await expect(
          chooser
        ).toBeVisible();

        await expect(
          chooser.getByText(
            "Connect with Phantom, Solflare, Backpack, or Jupiter.",
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
        await page.addInitScript(() => {
          Object.defineProperty(navigator, "userAgent", {
            configurable: true,
            get: () =>
              "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148"
          });
        });
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
                "Connect with Solflare"
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

        await expect(page.locator(".auth-card")).toHaveCount(1);
        await expect(page.locator(".wallet-chooser")).toHaveCount(1);
        await expect(page.locator(".wallet-app-links")).toHaveCount(0);
        await expect(page.locator(".wallet-choice")).toHaveCount(4);
        for (const wallet of SUPPORTED_WALLETS) {
          await expect(
            page.getByRole("button", { name: "Connect with " + wallet })
          ).toBeEnabled();
        }
      }
    );

    test(
      "an injected wallet browser uses one four-wallet chooser on one mobile sign-in page",
      async ({ page }) => {
        await registerWalletStandardMocks(page);
        await page.addInitScript(() => {
          Object.defineProperty(navigator, "userAgent", {
            configurable: true,
            get: () =>
              "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148"
          });
        });
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto("/auth");

        await expect(page.locator(".auth-card")).toHaveCount(1);
        const standardChooser = page.locator(".wallet-standard-chooser");
        for (const wallet of SUPPORTED_WALLETS) {
          await expect(standardChooser.getByText(wallet, { exact: true })).toBeVisible();
        }
        await expect(page.locator(".wallet-chooser")).toHaveCount(1);
        await expect(page.locator(".wallet-app-links")).toHaveCount(0);
        await expect(standardChooser.locator(".wallet-choice")).toHaveCount(4);
        for (const wallet of SUPPORTED_WALLETS) {
          await expect(standardChooser.getByRole("button", { name: "Connect with " + wallet })).toBeEnabled();
        }
        await standardChooser.getByRole("button", { name: "Connect with Backpack" }).click();
        await expect(page.locator(".auth-status")).toContainText("Backpack");
        await expect(page.getByRole("button", { name: "Sign in with wallet" })).toBeEnabled();
      }
    );

    test(
      "session-expiry notice appears once on the shared sign-in page",
      async ({ page }) => {
        await page.setViewportSize({ width: 390, height: 844 });
        await page.goto("/auth?reason=inactivity-expired");

        await expect(page.locator(".auth-card")).toHaveCount(1);
        await expect(page.locator(".notice")).toHaveCount(1);
        await expect(page.locator(".notice")).toContainText(
          "Your session expired after 12 hours of inactivity."
        );
      }
    );

    test(
      "connect action stays capped on wide viewports",
      async ({ page }) => {
        await registerWalletStandardMocks(page);
        await page.setViewportSize({
          width: 1440,
          height: 1000
        });

        await page.goto("/auth");

        const connectButton =
          page.getByRole(
            "button",
            {
              name: "Refresh wallet list"
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
        await registerWalletStandardMocks(page);
        await page.goto("/auth");

        await page.getByRole(
          "button",
          {
            name: "Refresh wallet list"
          }
        ).click();

        const chooser =
          page.locator(
            ".wallet-standard-chooser"
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
                    image instanceof HTMLImageElement &&
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
      "workspace deletion status and finalization require an authenticated session",
      async ({ request }) => {
        const workspaceId = "00000000-0000-4000-8000-000000000001";
        const getResponse = await request.get(
          `/api/workspaces/${workspaceId}/retention`
        );
        expect(getResponse.status()).toBe(401);

        const postResponse = await request.post(
          `/api/workspaces/${workspaceId}/retention`,
          {
            headers: {
              origin: "http://localhost:3100",
              "content-type": "application/json"
            },
            data: {
              action: "finalize",
              confirmation: "DELETE WORKSPACE DATA"
            }
          }
        );
        expect(postResponse.status()).toBe(401);
        await expect(postResponse.json()).resolves.toMatchObject({
          error: "authentication_required"
        });
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

  test("Gas Tank sponsorship APIs reject unauthenticated callers without exposing transaction or key material", async ({ request }) => {
    const workspaceId = "00000000-0000-4000-8000-000000000001";
    const runId = "00000000-0000-4000-8000-000000000002";
    const gasTankResponse = await request.get(
      `/api/workspaces/${workspaceId}/gas-tank`
    );
    expect(gasTankResponse.status()).toBe(401);
    const gasTankBody = await gasTankResponse.json();
    expect(gasTankBody.error).toBe("authentication_required");
    expect(JSON.stringify(gasTankBody)).not.toMatch(/privateKey|envelopeKey|transactionBase64/i);

    const sponsorResponse = await request.post(
      `/api/workspaces/${workspaceId}/payroll/runs/${runId}/sponsor`,
      {
        headers: {
          origin: "http://localhost:3100",
          "content-type": "application/json"
        },
        data: {
          action: "prepare",
          claimIds: ["01".repeat(32)]
        }
      }
    );
    expect(sponsorResponse.status()).toBe(401);
    const sponsorBody = await sponsorResponse.json();
    expect(sponsorBody.error).toBe("authentication_required");
    expect(JSON.stringify(sponsorBody)).not.toMatch(/privateKey|envelopeKey|transactionBase64/i);
  });
  }
);