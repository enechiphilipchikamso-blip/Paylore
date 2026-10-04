import {
  expect,
  test
} from "@playwright/test";

test.describe(
  "authentication boundary",
  () => {
    test("public authentication entry renders", async ({
      page
    }) => {
      await page.goto("/auth");

      await expect(
        page.getByRole("heading", {
          name: "Wallet authentication"
        })
      ).toBeVisible();

      await expect(
        page.getByRole("heading", {
          name: "Sign in to Paylore"
        })
      ).toBeVisible();

      await expect(
        page.locator(
          'meta[name="robots"]'
        )
      ).toHaveAttribute(
        "content",
        /noindex/
      );
    });

    test("protected workspace gateway redirects unauthenticated users", async ({
      page
    }) => {
      await page.goto("/app");

      await expect(page).toHaveURL(
        /\/auth\?next=%2Fapp$/
      );
    });

    test("workspace creation fails closed without a session", async ({
      request
    }) => {
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
    });

    test("state-changing auth endpoints reject cross-origin requests", async ({
      request
    }) => {
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
    });

    test("session endpoint never returns a raw session token", async ({
      request
    }) => {
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

      expect(body).not.toHaveProperty(
        "token"
      );

      expect(body).not.toHaveProperty(
        "sessionToken"
      );

      expect(body).not.toHaveProperty(
        "cookie"
      );
    });
  }
);