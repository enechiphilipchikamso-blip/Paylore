import {
  expect,
  test
} from "@playwright/test";

test("home page renders", async ({ page }) => {
  await page.goto("/");

  await expect(
    page.getByRole("heading", {
      name: "Paylore"
    })
  ).toBeVisible();

  await expect(
    page.getByTestId("foundation-status")
  ).toHaveText("Batch 01 foundation");
});

test("health endpoint exposes only safe status data", async ({
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