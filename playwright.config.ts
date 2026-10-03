import {
  defineConfig,
  devices
} from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: [
    ["line"],
    ["html"],
    ["./tests/e2e/merge-video-reporter.ts"]
  ],
  use: {
    baseURL: "http://localhost:3100",
    trace: "retain-on-failure",
    screenshot: "on",
    video: "on"
  },
  webServer: {
    command: "PORT=3100 pnpm dev",
    url: "http://localhost:3100",
    reuseExistingServer: false,
    timeout: 120000
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"]
      }
    }
  ]
});