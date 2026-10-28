import { defineConfig } from "drizzle-kit";
import { existsSync } from "node:fs";

// `drizzle-kit generate` only diffs the schema and does not need a database
// connection, so credentials are attached only when DATABASE_URL is available
// (required for `drizzle-kit migrate`).
if (!process.env.DATABASE_URL && existsSync(".env.local")) {
  process.loadEnvFile(".env.local");
}

const databaseUrl = process.env.DATABASE_URL;

export default defineConfig({
  dialect: "postgresql",
  schema: "./packages/database/src/schema.ts",
  out: "./packages/database/drizzle",
  ...(databaseUrl ? { dbCredentials: { url: databaseUrl } } : {})
});
