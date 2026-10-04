import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export function createDatabase(connectionString: string) {
  const client = postgres(connectionString, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 10,
    prepare: false
  });

  const db = drizzle(client, {
    schema
  });

  return {
    client,
    db
  };
}

export type Database = ReturnType<
  typeof createDatabase
>["db"];

export async function checkDatabase(
  connectionString: string
): Promise<void> {
  const { client, db } = createDatabase(connectionString);

  try {
    await db.execute(sql`select 1`);
  } finally {
    await client.end({ timeout: 1 });
  }
}