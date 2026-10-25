import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "../../packages/database/src/repositories.subscription-reminders.test.ts",
      "../../packages/database/src/retention-policy.subscription-reminders.test.ts",
      "../../packages/database/src/repositories.canonical-reconciliation.test.ts"
    ]
  }
});