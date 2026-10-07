import { fixupConfigRules } from "@eslint/compat";
import {
  defineConfig,
  globalIgnores
} from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import tseslint from "typescript-eslint";

export default defineConfig([
  ...fixupConfigRules(nextVitals),
  {
    files: ["eslint.config.mjs", "vitest.config.mts"],
    languageOptions: {
      parser: tseslint.parser
    }
  },
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts"
  ])
]);