import { describe, expect, it } from "vitest";
import {
  ConfigurationError,
  parseConfig,
  parsePayloreConfig
} from "./config";

const baseEnv = {
  NODE_ENV: "test",
  SOLANA_NETWORK: "devnet",
  SOLANA_RPC_PRIMARY: "https://api.devnet.solana.com",
  DATABASE_URL:
    "postgresql://user:pass@localhost:5432/paylore"
} as const;

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
});