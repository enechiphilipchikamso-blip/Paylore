import "server-only";

import {
  createDatabase,
  type Database
} from "@paylore/database";
import { loadConfig } from "./config";

type DatabaseContainer = ReturnType<
  typeof createDatabase
>;

let databaseContainer: DatabaseContainer | undefined;

export function getDatabase(): Database {
  if (!databaseContainer) {
    databaseContainer = createDatabase(
      loadConfig().DATABASE_URL
    );
  }

  return databaseContainer.db;
}