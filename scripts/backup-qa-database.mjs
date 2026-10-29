import { chmod, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawn } from "node:child_process";
import { resolve } from "node:path";

const backupDirectory = "/tmp/paylore-qa";
const backupFile = resolve(backupDirectory, "paylore-pre-regression.dump");

function loadLocalEnvironment() {
  const environmentFile = resolve(process.cwd(), ".env.local");
  if (existsSync(environmentFile)) {
    process.loadEnvFile(environmentFile);
  }
}

function databaseUrl() {
  const url = process.env.PAYLORE_QA_DATABASE_URL?.trim();
  if (!url) {
    throw new Error(
      "PAYLORE_QA_DATABASE_URL is required in .env.local or the process environment."
    );
  }
  if (!url.startsWith("postgres://") && !url.startsWith("postgresql://")) {
    throw new Error("PAYLORE_QA_DATABASE_URL must use postgres:// or postgresql://.");
  }
  return url;
}

async function run(command, args) {
  await new Promise((resolveProcess, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolveProcess();
      } else {
        reject(
          new Error(
            `${command} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}.`
          )
        );
      }
    });
  }).catch((error) => {
    if (error instanceof Error && error.message.startsWith(`${command} failed`)) {
      throw error;
    }
    throw new Error(`${command} could not be started.`);
  });
}

async function main() {
  loadLocalEnvironment();
  const url = databaseUrl();

  await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
  await chmod(backupDirectory, 0o700);

  await run("psql", [
    url,
    "-X",
    "-v",
    "ON_ERROR_STOP=1",
    "-c",
    "SELECT current_database() AS database_name, current_user AS database_role, current_setting('server_version') AS postgres_version, inet_server_addr() AS server_address;"
  ]);
  await run("pg_dump", [
    `--dbname=${url}`,
    "--format=custom",
    "--no-owner",
    "--no-privileges",
    `--file=${backupFile}`
  ]);
  await chmod(backupFile, 0o600);
  await run("pg_restore", ["--list", backupFile]);
}

main().catch((error) => {
  process.stderr.write(
    `QA database backup failed: ${error instanceof Error ? error.message : "unknown error"}\n`
  );
  process.exitCode = 1;
});
