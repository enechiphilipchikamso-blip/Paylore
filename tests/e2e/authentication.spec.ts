import {
  expect,
  test
} from "@playwright/test";

const SUPPORTED_WALLETS = [
  "Phantom",
  "Solflare",
  "Backpack",
  "Jupiter Wallet Extension"
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
      "mobile browsers do not expose a wallet connection flow",
      async ({ page }) => {
        await page.setViewportSize(
          {
            width: 390,
            height: 844
          }
        );

        await page.goto("/auth");

        await expect(
          page.getByText(
            "Paylore wallet connection for the MVP requires a desktop browser with Phantom, Solflare, Backpack, or Jupiter Wallet Extension.",
            { exact: true }
          )
        ).toBeVisible();

        await expect(
          page.getByRole(
            "button",
            {
              name:
                "Connect wallet"
            }
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
  }
);