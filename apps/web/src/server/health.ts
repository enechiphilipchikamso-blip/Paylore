import { checkDatabase } from "@paylore/database";
import {
  ConfigurationError,
  loadConfig,
  type AppConfig
} from "./config";

type HealthSuccess = {
  statusCode: 200;
  payload: {
    status: "ok";
    service: "paylore-web";
    checks: {
      configuration: "ok";
      database: "ok";
    };
  };
};

type HealthFailure = {
  statusCode: 503;
  payload: {
    status: "error";
    service: "paylore-web";
    checks: {
      configuration: "ok" | "failed";
      database: "failed" | "not_checked";
    };
    code: "CONFIGURATION_INVALID" | "DATABASE_UNAVAILABLE";
  };
};

export async function getHealthStatus(
  checker: (connectionString: string) => Promise<void> = checkDatabase,
  configLoader: () => AppConfig = loadConfig
): Promise<HealthSuccess | HealthFailure> {
  try {
    const config = configLoader();

    try {
      await checker(config.DATABASE_URL);
    } catch {
      return {
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
      };
    }

    return {
      statusCode: 200,
      payload: {
        status: "ok",
        service: "paylore-web",
        checks: {
          configuration: "ok",
          database: "ok"
        }
      }
    };
  } catch (error) {
    if (error instanceof ConfigurationError) {
      return {
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
      };
    }

    return {
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
    };
  }
}