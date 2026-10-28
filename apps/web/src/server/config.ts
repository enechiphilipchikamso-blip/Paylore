import { z } from "zod";
import { address } from "@solana/kit";
import { getTokenWrapProgramId } from "./solana/token-wrap-program";

const envelopeKeySchema = z.string().refine((value) => {
  const bytes = Buffer.from(value, "base64");
  return bytes.length === 32 && bytes.toString("base64") === value;
}, "Envelope keys must be base64-encoded 32-byte values.");

const optionalSolanaAddressSchema = z.preprocess(
  (value) =>
    typeof value === "string" && value.trim() === ""
      ? undefined
      : value,
  z.string().refine((value) => {
    try {
      address(value);
      return true;
    } catch {
      return false;
    }
  }, "Must be a valid Solana address.").optional()
);

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
    .preprocess(
      (value) =>
        typeof value === "string" && value.trim() === ""
          ? undefined
          : value,
      z.string().url().optional()
    ),
  PAYLORE_RPC_SECONDARY_API_KEY: z
    .string()
    .optional(),
  PAYLORE_SUBSCRIPTION_RECIPIENT: optionalSolanaAddressSchema,
  PAYLORE_SUBSCRIPTION_USDC_MINT: optionalSolanaAddressSchema,
  PAYLORE_WRAPPED_USDC_MINT: optionalSolanaAddressSchema,
  PAYLORE_PAYROLL_PROGRAM_ID: optionalSolanaAddressSchema,
  PAYLORE_PAYROLL_AMOUNT_COMMITMENT_SECRET: z
    .string()
    .regex(/^[0-9a-fA-F]{64}$/, "Must be a 32-byte hexadecimal secret.")
    .optional(),
  PAYLORE_TOKEN_WRAP_UNWRAP_ENABLED: z
    .enum(["true", "false"])
    .default("true"),
  PAYLORE_RESERVE_ENVELOPE_KEY: z
    .string()
    .optional(),
  PAYLORE_GAS_TANK_ENVELOPE_KEY: z
    .preprocess(
      (value) => value === "" ? undefined : value,
      envelopeKeySchema.optional()
    ),
  PAYLORE_HELIUS_WEBHOOK_SECRET: z
    .string()
    .optional(),
  PAYLORE_HELIUS_DEPLOYMENT_ADDRESS: optionalSolanaAddressSchema,
  PAYLORE_HELIUS_MANAGEMENT_API_KEY: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().min(1).optional()
  ),
  PAYLORE_HELIUS_WEBHOOK_ID: z.preprocess(
    (value) => typeof value === "string" && value.trim() === "" ? undefined : value,
    z.string().min(1).optional()
  )
}).superRefine((config, context) => {
  if (
    config.PAYLORE_RESERVE_ENVELOPE_KEY &&
    config.PAYLORE_GAS_TANK_ENVELOPE_KEY &&
    config.PAYLORE_RESERVE_ENVELOPE_KEY ===
      config.PAYLORE_GAS_TANK_ENVELOPE_KEY
  ) {
    context.addIssue({
      code: "custom",
      path: ["PAYLORE_GAS_TANK_ENVELOPE_KEY"],
      message: "The Gas Tank envelope key must be separate from the reserve key."
    });
  }
});

export type PayloreConfig = z.infer<typeof payloreConfigSchema> & {
  TOKEN_WRAP_PROGRAM_ID: ReturnType<typeof getTokenWrapProgramId>;
  TOKEN_WRAP_UNWRAP_ENABLED: boolean;
};

export class ConfigurationError extends Error {
  readonly invalidKeys: string[];

  constructor(invalidKeys: string[] = []) {
    // Only variable names are reported, never their values.
    super(
      invalidKeys.length > 0
        ? `Server configuration is invalid: ${invalidKeys.join(", ")}.`
        : "Server configuration is invalid."
    );
    this.name = "ConfigurationError";
    this.invalidKeys = invalidKeys;
  }
}

function invalidKeysOf(error: z.ZodError): string[] {
  return [
    ...new Set(
      error.issues.map((issue) => String(issue.path[0] ?? "unknown"))
    )
  ];
}

// Strip surrounding whitespace and accidental wrapping quotes that are easy
// to introduce when pasting values into the Netlify UI.
function normalizeEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const normalized: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    normalized[key] =
      typeof value === "string"
        ? value.trim().replace(/^(["'])(.*)\1$/, "$2").trim()
        : value;
  }
  return normalized as NodeJS.ProcessEnv;
}

export function parseConfig(
  env: NodeJS.ProcessEnv
): AppConfig {
  const result = envSchema.safeParse(normalizeEnv(env));

  if (!result.success) {
    throw new ConfigurationError(invalidKeysOf(result.error));
  }

  return result.data;
}

export function loadConfig(): AppConfig {
  return parseConfig(process.env);
}

export function parsePayloreConfig(
  env: NodeJS.ProcessEnv
): PayloreConfig {
  env = normalizeEnv(env);
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
    throw new ConfigurationError(invalidKeysOf(result.error));
  }

  return {
    ...result.data,
    TOKEN_WRAP_PROGRAM_ID: getTokenWrapProgramId(result.data.PAYLORE_NETWORK),
    TOKEN_WRAP_UNWRAP_ENABLED:
      result.data.PAYLORE_TOKEN_WRAP_UNWRAP_ENABLED === "true"
  };
}

export function loadPayloreConfig(): PayloreConfig {
  return parsePayloreConfig(process.env);
}
