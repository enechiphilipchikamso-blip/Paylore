import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "../../packages/database/src/**/*.test.ts",
      "../../netlify/functions/**/*.test.mts"
    ]
  }
});
