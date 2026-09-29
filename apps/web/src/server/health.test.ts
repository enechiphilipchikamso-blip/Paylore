import {
  describe,
  expect,
  it,
  vi
} from "vitest";
import {
  ConfigurationError,
  type AppConfig
} from "./config";
import { getHealthStatus } from "./health";

const config: AppConfig = {
  NODE_ENV: "test",
  SOLANA_NETWORK: "devnet",
  SOLANA_RPC_PRIMARY: "https://api.devnet.solana.com",
  DATABASE_URL:
    "postgresql://user:pass@localhost:5432/paylore"
};

describe("getHealthStatus", () => {
  it("returns healthy when configuration and database are available", async () => {
    const checker = vi.fn().mockResolvedValue(undefined);
    const configLoader = vi.fn(() => config);

    const result = await getHealthStatus(
      checker,
      configLoader
    );

    expect(checker).toHaveBeenCalledWith(
      config.DATABASE_URL
    );

    expect(result).toEqual({
      statusCode: 200,
      payload: {
        status: "ok",
        service: "paylore-web",
        checks: {
          configuration: "ok",
          database: "ok"
        }
      }
    });
  });

  it("returns controlled database failure", async () => {
    const checker = vi
      .fn()
      .mockRejectedValue(new Error("database unavailable"));
    const configLoader = vi.fn(() => config);

    const result = await getHealthStatus(
      checker,
      configLoader
    );

    expect(result).toEqual({
      statusCode: 503,
      payload: {
        status: "error",
        service: "paylore-web",
        checks: {
          configuration: "ok",
          database: "failed"
        },
        code: "DATABASE_UNAVAILABLE"
      }
    });
  });

  it("returns controlled configuration failure without checking the database", async () => {
    const checker = vi.fn();

    const result = await getHealthStatus(
      checker,
      () => {
        throw new ConfigurationError();
      }
    );

    expect(checker).not.toHaveBeenCalled();

    expect(result).toEqual({
      statusCode: 503,
      payload: {
        status: "error",
        service: "paylore-web",
        checks: {
          configuration: "failed",
          database: "not_checked"
        },
        code: "CONFIGURATION_INVALID"
      }
    });
  });
});