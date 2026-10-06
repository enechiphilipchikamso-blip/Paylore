import { fixupConfigRules } from "@eslint/compat";
import {
  defineConfig,
  globalIgnores
} from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";

export default defineConfig([
  ...fixupConfigRules(nextVitals),
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts"
  ])
]);