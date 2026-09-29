import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  SOLANA_NETWORK: z.literal("devnet").default("devnet"),
  SOLANA_RPC_PRIMARY: z
    .string()
    .url()
    .default("https://api.devnet.solana.com"),
  DATABASE_URL: z
    .string()
    .url()
    .refine(
      (value) =>
        value.startsWith("postgres://") ||
        value.startsWith("postgresql://"),
      "DATABASE_URL must use postgres:// or postgresql://"
    )
});

export type AppConfig = z.infer<typeof envSchema>;

export class ConfigurationError extends Error {
  constructor() {
    super("Server configuration is invalid.");
    this.name = "ConfigurationError";
  }
}

export function parseConfig(
  env: NodeJS.ProcessEnv
): AppConfig {
  const result = envSchema.safeParse(env);

  if (!result.success) {
    throw new ConfigurationError();
  }

  return result.data;
}

export function loadConfig(): AppConfig {
  return parseConfig(process.env);
} 