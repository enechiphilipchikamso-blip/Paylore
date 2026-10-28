import { defineConfig } from "vitest/config";

export default defineConfig({
  oxc: {
    jsx: {
      runtime: "automatic"
      }
  },
  test: {
    environment: "node",
    setupFiles: ["./src/test/setup.ts"],
    include: [
      "src/**/*.test.ts",
      "src/**/*.test.tsx",
      "../../packages/database/src/**/*.test.ts",
      "../../__tests__/functions/**/*.test.mts"
    ]
  }
});
