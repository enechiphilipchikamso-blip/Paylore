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

const payloreConfigSchema = z.object({
  PAYLORE_NETWORK: z
    .literal("devnet")
    .default("devnet"),
  PAYLORE_RPC_PRIMARY_PROVIDER: z
    .enum(["helius", "quicknode", "solana", "custom"])
    .default("solana"),
  PAYLORE_RPC_PRIMARY_URL: z
    .string()
    .url()
    .default("https://api.devnet.solana.com"),
  PAYLORE_RPC_PRIMARY_API_KEY: z
    .string()
    .optional(),
  PAYLORE_RPC_SECONDARY_PROVIDER: z
    .enum(["helius", "quicknode", "solana", "custom"])
    .optional(),
  PAYLORE_RPC_SECONDARY_URL: z
    .string()
    .url()
    .optional(),
  PAYLORE_RPC_SECONDARY_API_KEY: z
    .string()
    .optional(),
  PAYLORE_SUBSCRIPTION_RECIPIENT: z
    .string()
    .optional(),
  PAYLORE_SUBSCRIPTION_USDC_MINT: z
    .string()
    .optional(),
  PAYLORE_WRAPPED_USDC_MINT: z
    .string()
    .optional(),
  PAYLORE_PAYROLL_PROGRAM_ID: z
    .string()
    .optional(),
  PAYLORE_RESERVE_ENVELOPE_KEY: z
    .string()
    .optional(),
  PAYLORE_HELIUS_WEBHOOK_SECRET: z
    .string()
    .optional()
});

export type PayloreConfig = z.infer<
  typeof payloreConfigSchema
>;

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

export function parsePayloreConfig(
  env: NodeJS.ProcessEnv
): PayloreConfig {
  const result =
    payloreConfigSchema.safeParse({
      ...env,
      PAYLORE_NETWORK:
        env.PAYLORE_NETWORK ??
        env.SOLANA_NETWORK,
      PAYLORE_RPC_PRIMARY_URL:
        env.PAYLORE_RPC_PRIMARY_URL ??
        env.SOLANA_RPC_PRIMARY
    });

  if (!result.success) {
    throw new ConfigurationError();
  }

  return result.data;
}

export function loadPayloreConfig(): PayloreConfig {
  return parsePayloreConfig(process.env);
}