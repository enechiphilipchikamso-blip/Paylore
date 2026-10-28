import { describe, expect, it } from "vitest";
import {
  ConfigurationError,
  parseConfig,
  parsePayloreConfig
} from "./config";
import { getTokenWrapProgramId } from "./solana/token-wrap-program";

const baseEnv = {
  NODE_ENV: "test",
  SOLANA_NETWORK: "devnet",
  SOLANA_RPC_PRIMARY: "https://api.devnet.solana.com",
  DATABASE_URL:
    "postgresql://user:pass@localhost:5432/paylore"
} as const;
const reserveKey = Buffer.alloc(32, 1).toString("base64");
const gasTankKey = Buffer.alloc(32, 2).toString("base64");

describe("parseConfig", () => {
  it("accepts valid configuration", () => {
    expect(parseConfig(baseEnv)).toEqual(baseEnv);
  });

  it("rejects missing database configuration", () => {
    expect(() =>
      parseConfig({
        ...baseEnv,
        DATABASE_URL: undefined
      })
    ).toThrow(ConfigurationError);
  });

  it("rejects non-devnet network configuration", () => {
    expect(() =>
      parseConfig({
        ...baseEnv,
        SOLANA_NETWORK: "mainnet"
      })
    ).toThrow(ConfigurationError);
  });
});

describe("parsePayloreConfig", () => {
  it("treats an empty optional secondary RPC URL as unconfigured", () => {
    const config = parsePayloreConfig({
      NODE_ENV: "test",
      SOLANA_NETWORK: "devnet",
      SOLANA_RPC_PRIMARY: "https://api.devnet.solana.com",
      PAYLORE_RPC_SECONDARY_PROVIDER: "quicknode",
      PAYLORE_RPC_SECONDARY_URL: ""
    });

    expect(config.PAYLORE_RPC_SECONDARY_PROVIDER).toBe("quicknode");
    expect(config.PAYLORE_RPC_SECONDARY_URL).toBeUndefined();
  });

  it("rejects a malformed configured secondary RPC URL", () => {
    expect(() =>
      parsePayloreConfig({
        NODE_ENV: "test",
        PAYLORE_RPC_SECONDARY_PROVIDER: "quicknode",
        PAYLORE_RPC_SECONDARY_URL: "not-a-provider-url"
      })
    ).toThrow(ConfigurationError);
  });

  it("accepts a separate optional Gas Tank envelope key", () => {
    const config = parsePayloreConfig({
      NODE_ENV: "test",
      PAYLORE_RESERVE_ENVELOPE_KEY: reserveKey,
      PAYLORE_GAS_TANK_ENVELOPE_KEY: gasTankKey
    });

    expect(config.PAYLORE_GAS_TANK_ENVELOPE_KEY).toBe(
      gasTankKey
    );
  });

  it("accepts a dedicated 32-byte payroll amount commitment secret", () => {
    const secret = "42".repeat(32);
    expect(parsePayloreConfig({
      NODE_ENV: "test",
      PAYLORE_PAYROLL_AMOUNT_COMMITMENT_SECRET: secret
    }).PAYLORE_PAYROLL_AMOUNT_COMMITMENT_SECRET).toBe(secret);
  });

  it("rejects a malformed payroll amount commitment secret", () => {
    expect(() => parsePayloreConfig({
      NODE_ENV: "test",
      PAYLORE_PAYROLL_AMOUNT_COMMITMENT_SECRET: "not-a-key"
    })).toThrow(ConfigurationError);
  });

  it("rejects reuse of the reserve envelope key for the Gas Tank", () => {
    expect(() =>
      parsePayloreConfig({
        NODE_ENV: "test",
        PAYLORE_RESERVE_ENVELOPE_KEY: reserveKey,
        PAYLORE_GAS_TANK_ENVELOPE_KEY: reserveKey
      })
    ).toThrow(ConfigurationError);
  });

  it("rejects a Gas Tank envelope key that is not a 32-byte base64 value", () => {
    expect(() =>
      parsePayloreConfig({
        NODE_ENV: "test",
        PAYLORE_GAS_TANK_ENVELOPE_KEY: "not-a-key"
      })
    ).toThrow(ConfigurationError);
  });

  it("rejects placeholder text for configured Solana account identifiers", () => {
    expect(() =>
      parsePayloreConfig({
        NODE_ENV: "test",
        PAYLORE_PAYROLL_PROGRAM_ID: "<deployed Devnet program ID>"
      })
    ).toThrow(ConfigurationError);
  });

  it("treats blank optional mint identifiers as unconfigured", () => {
    const config = parsePayloreConfig({
      NODE_ENV: "test",
      PAYLORE_WRAPPED_USDC_MINT: ""
    });

    expect(config.PAYLORE_WRAPPED_USDC_MINT).toBeUndefined();
  });

  it("selects the custom Token Wrap program for Devnet", () => {
    const config = parsePayloreConfig({
      NODE_ENV: "test",
      PAYLORE_NETWORK: "devnet"
    });

    expect(config.TOKEN_WRAP_PROGRAM_ID).toBe(
      "58yEtWEhrsRery3w1kZiTXdWofY6efvxmeAZwLrexgQ"
    );
  });

  it("accepts and validates the public deployment address used by webhook monitoring", () => {
    const deploymentAddress = "7dmrSuBZtHzvkuiYgUW386gKYaeeE3jQs4sQsWkQQiUe";
    expect(parsePayloreConfig({
      NODE_ENV: "test",
      PAYLORE_HELIUS_DEPLOYMENT_ADDRESS: deploymentAddress
    }).PAYLORE_HELIUS_DEPLOYMENT_ADDRESS).toBe(deploymentAddress);
    expect(() => parsePayloreConfig({
      NODE_ENV: "test",
      PAYLORE_HELIUS_DEPLOYMENT_ADDRESS: "not-a-solana-address"
    })).toThrow(ConfigurationError);
  });

  it("accepts server-only Helius webhook management configuration", () => {
    const config = parsePayloreConfig({
      NODE_ENV: "test",
      PAYLORE_HELIUS_MANAGEMENT_API_KEY: "helius-management-key",
      PAYLORE_HELIUS_WEBHOOK_ID: "existing-webhook-id"
    });

    expect(config.PAYLORE_HELIUS_MANAGEMENT_API_KEY).toBe("helius-management-key");
    expect(config.PAYLORE_HELIUS_WEBHOOK_ID).toBe("existing-webhook-id");
  });

  it("treats blank Helius management settings as unconfigured", () => {
    const config = parsePayloreConfig({
      NODE_ENV: "test",
      PAYLORE_HELIUS_MANAGEMENT_API_KEY: " ",
      PAYLORE_HELIUS_WEBHOOK_ID: ""
    });

    expect(config.PAYLORE_HELIUS_MANAGEMENT_API_KEY).toBeUndefined();
    expect(config.PAYLORE_HELIUS_WEBHOOK_ID).toBeUndefined();
  });

  it("enables the Devnet unwrap path by default while preserving an explicit opt-out", () => {
    expect(
      parsePayloreConfig({ NODE_ENV: "test" }).TOKEN_WRAP_UNWRAP_ENABLED
    ).toBe(true);
    expect(
      parsePayloreConfig({
        NODE_ENV: "test",
        PAYLORE_TOKEN_WRAP_UNWRAP_ENABLED: "false"
      }).TOKEN_WRAP_UNWRAP_ENABLED
    ).toBe(false);
    expect(
      parsePayloreConfig({
        NODE_ENV: "test",
        PAYLORE_TOKEN_WRAP_UNWRAP_ENABLED: "true"
      }).TOKEN_WRAP_UNWRAP_ENABLED
    ).toBe(true);
    expect(() =>
      parsePayloreConfig({
        NODE_ENV: "test",
        PAYLORE_TOKEN_WRAP_UNWRAP_ENABLED: "yes"
      })
    ).toThrow(ConfigurationError);
  });

  it("keeps the official Token Wrap program ID selected for Mainnet", () => {
    expect(getTokenWrapProgramId("mainnet")).toBe(
      "TwRapQCDhWkZRrDaHfZGuHxkZ91gHDRkyuzNqeU5MgR"
    );
  });
});
