import { describe, expect, it } from "vitest";
import {
  ConfigurationError,
  parseConfig
} from "./config";

const baseEnv = {
  NODE_ENV: "test",
  SOLANA_NETWORK: "devnet",
  SOLANA_RPC_PRIMARY: "https://api.devnet.solana.com",
  DATABASE_URL:
    "postgresql://user:pass@localhost:5432/paylore"
};

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