import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import {
  rewrapGasTankKey,
  rewrapReserveKey
} from "../apps/web/src/server/reserve-crypto-policy.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const recoveryPath = resolve(root, ".paylore-envelope-rotation.json");
const encryptedFields = {
  workspaceId: "workspace_id",
  address: "address",
  encryptedPrivateKey: "encrypted_private_key",
  privateKeyNonce: "private_key_nonce",
  privateKeyAuthTag: "private_key_auth_tag",
  encryptedDataKey: "encrypted_data_key",
  dataKeyNonce: "data_key_nonce",
  dataKeyAuthTag: "data_key_auth_tag",
  encryptedBackup: "encrypted_backup",
  backupNonce: "backup_nonce",
  backupAuthTag: "backup_auth_tag"
};

function usage() {
  console.error(
    "Usage: pnpm keys:rotate [--apply | --resume]\n" +
      "Without a flag, the command only decrypt-checks stored records."
  );
}

function readArguments() {
  const argumentsList = process.argv.slice(2);
  if (argumentsList[0] === "--") argumentsList.shift();
  if (
    argumentsList.length > 1 ||
    (argumentsList.length === 1 &&
      argumentsList[0] !== "--apply" &&
      argumentsList[0] !== "--resume")
  ) {
    usage();
    process.exitCode = 2;
    return null;
  }
  return argumentsList[0] ?? "check";
}

function loadLocalEnvironment() {
  for (const directory of [resolve(root, "apps/web"), root]) {
    const file = resolve(directory, ".env.local");
    if (existsSync(file)) {
      process.loadEnvFile(file);
    }
  }
}

function requireEnvironment(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable ${name} is missing.`);
  }
  return value;
}

function validateEnvelopeKey(value, name) {
  const bytes = Buffer.from(value, "base64");
  if (bytes.length !== 32 || bytes.toString("base64") !== value) {
    bytes.fill(0);
    throw new Error(`${name} must be a canonical Base64 encoding of 32 bytes.`);
  }
  bytes.fill(0);
  return value;
}

function readCurrentKeys() {
  return {
    reserve: validateEnvelopeKey(
      requireEnvironment("PAYLORE_RESERVE_ENVELOPE_KEY"),
      "PAYLORE_RESERVE_ENVELOPE_KEY"
    ),
    gasTank: validateEnvelopeKey(
      requireEnvironment("PAYLORE_GAS_TANK_ENVELOPE_KEY"),
      "PAYLORE_GAS_TANK_ENVELOPE_KEY"
    )
  };
}

function requireDistinctKeys(keys) {
  if (keys.reserve === keys.gasTank) {
    throw new Error("Reserve and Gas Tank envelope keys must be distinct.");
  }
}

function encryptedRecord(row) {
  return Object.fromEntries(
    Object.entries(encryptedFields).map(([property, column]) => [
      property,
      row[column]
    ])
  );
}

function createNextKeys(currentKeys) {
  let reserve;
  let gasTank;
  do {
    reserve = randomBytes(32).toString("base64");
  } while (reserve === currentKeys.reserve);
  do {
    gasTank = randomBytes(32).toString("base64");
  } while (
    gasTank === currentKeys.gasTank ||
    gasTank === reserve
  );
  return { reserve, gasTank };
}

async function rotateDatabase(database, currentKeys, nextKeys) {
  return database.begin(async (transaction) => {
    await transaction`
      LOCK TABLE workspace_reserves, workspace_gas_tanks
      IN ACCESS EXCLUSIVE MODE
    `;
    const reserves = await transaction`
      SELECT * FROM workspace_reserves FOR UPDATE
    `;
    const gasTanks = await transaction`
      SELECT * FROM workspace_gas_tanks FOR UPDATE
    `;

    for (const source of reserves) {
      const reserve = encryptedRecord(source);
      const rewrapped = rewrapReserveKey(
        reserve.workspaceId,
        reserve,
        currentKeys.reserve,
        nextKeys.reserve
      );
      const updated = await transaction`
        UPDATE workspace_reserves
        SET encrypted_private_key = ${rewrapped.encryptedPrivateKey},
          private_key_nonce = ${rewrapped.privateKeyNonce},
          private_key_auth_tag = ${rewrapped.privateKeyAuthTag},
          encrypted_data_key = ${rewrapped.encryptedDataKey},
          data_key_nonce = ${rewrapped.dataKeyNonce},
          data_key_auth_tag = ${rewrapped.dataKeyAuthTag},
          encrypted_backup = ${rewrapped.encryptedBackup},
          backup_nonce = ${rewrapped.backupNonce},
          backup_auth_tag = ${rewrapped.backupAuthTag},
          updated_at = now()
        WHERE workspace_id = ${reserve.workspaceId}
        RETURNING workspace_id
      `;
      if (updated.length !== 1) {
        throw new Error("A reserve record changed during key rotation.");
      }
    }
    for (const source of gasTanks) {
      const gasTank = encryptedRecord(source);
      const rewrapped = rewrapGasTankKey(
        gasTank.workspaceId,
        gasTank,
        currentKeys.gasTank,
        nextKeys.gasTank
      );
      const updated = await transaction`
        UPDATE workspace_gas_tanks
        SET encrypted_private_key = ${rewrapped.encryptedPrivateKey},
          private_key_nonce = ${rewrapped.privateKeyNonce},
          private_key_auth_tag = ${rewrapped.privateKeyAuthTag},
          encrypted_data_key = ${rewrapped.encryptedDataKey},
          data_key_nonce = ${rewrapped.dataKeyNonce},
          data_key_auth_tag = ${rewrapped.dataKeyAuthTag},
          encrypted_backup = ${rewrapped.encryptedBackup},
          backup_nonce = ${rewrapped.backupNonce},
          backup_auth_tag = ${rewrapped.backupAuthTag},
          updated_at = now()
        WHERE workspace_id = ${gasTank.workspaceId}
        RETURNING workspace_id
      `;
      if (updated.length !== 1) {
        throw new Error("A Gas Tank record changed during key rotation.");
      }
    }
    return {
      reserves: reserves.length,
      gasTanks: gasTanks.length
    };
  });
}

async function verifyDatabase(database, keys) {
  const [reserves, gasTanks] = await Promise.all([
    database`SELECT * FROM workspace_reserves`,
    database`SELECT * FROM workspace_gas_tanks`
  ]);
  for (const source of reserves) {
    const reserve = encryptedRecord(source);
    rewrapReserveKey(
      reserve.workspaceId,
      reserve,
      keys.reserve,
      keys.reserve
    );
  }
  for (const source of gasTanks) {
    const gasTank = encryptedRecord(source);
    rewrapGasTankKey(
      gasTank.workspaceId,
      gasTank,
      keys.gasTank,
      keys.gasTank
    );
  }
  return {
    reserves: reserves.length,
    gasTanks: gasTanks.length
  };
}

function writeRestrictedFile(path, contents, mode = 0o600) {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  const descriptor = openSync(temporaryPath, "wx", mode);
  try {
    writeFileSync(descriptor, contents, { encoding: "utf8" });
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporaryPath, path);
  const directoryDescriptor = openSync(dirname(path), "r");
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
}

function writeRecoveryRecord(keys) {
  if (existsSync(recoveryPath)) {
    throw new Error(
      "A protected recovery record already exists; use --resume before starting another rotation."
    );
  }
  writeRestrictedFile(
    recoveryPath,
    `${JSON.stringify({ version: 1, keys })}\n`
  );
}

function readRecoveryRecord() {
  const record = JSON.parse(readFileSync(recoveryPath, "utf8"));
  if (
    record?.version !== 1 ||
    typeof record.keys?.reserve !== "string" ||
    typeof record.keys?.gasTank !== "string"
  ) {
    throw new Error("The protected recovery record is invalid.");
  }
  const keys = {
    reserve: validateEnvelopeKey(
      record.keys.reserve,
      "recovery Reserve key"
    ),
    gasTank: validateEnvelopeKey(
      record.keys.gasTank,
      "recovery Gas Tank key"
    )
  };
  requireDistinctKeys(keys);
  return keys;
}

function updateEnvironmentFile(path, keys) {
  const original = existsSync(path) ? readFileSync(path, "utf8") : "";
  const newline = original.includes("\r\n") ? "\r\n" : "\n";
  const lines = original.split(/\r?\n/);
  const values = {
    PAYLORE_RESERVE_ENVELOPE_KEY: keys.reserve,
    PAYLORE_GAS_TANK_ENVELOPE_KEY: keys.gasTank
  };
  for (const [name, value] of Object.entries(values)) {
    const pattern = new RegExp(`^(\\s*(?:export\\s+)?${name}\\s*=).*$`);
    let matches = 0;
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(pattern);
      if (match) {
        matches += 1;
        lines[index] = `${match[1]}${value}`;
      }
    }
    if (matches > 1) {
      throw new Error(`${name} appears more than once in ${path}.`);
    }
    if (matches === 0) {
      lines.push(`${name}=${value}`);
    }
  }
  while (lines.length > 0 && lines.at(-1) === "") {
    lines.pop();
  }
  const contents = `${lines.join(newline)}${newline}`;
  writeRestrictedFile(path, contents);
}

function updateLocalEnvironment(keys) {
  for (const path of [
    resolve(root, ".env.local"),
    resolve(root, "apps/web/.env.local")
  ]) {
    updateEnvironmentFile(path, keys);
  }
}

function safeFailureCode(error) {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
  ) {
    return error.code;
  }
  if (!(error instanceof Error)) return "UnknownError";

  let message = error.message;
  for (const name of [
    "DATABASE_URL",
    "PAYLORE_RESERVE_ENVELOPE_KEY",
    "PAYLORE_GAS_TANK_ENVELOPE_KEY"
  ]) {
    const value = process.env[name];
    if (value) message = message.replaceAll(value, "[redacted]");
  }
  message = message.replace(
    /(postgres(?:ql)?:\/\/)[^@\s]+@/gi,
    "$1[redacted]@"
  );
  return `${error.name}: ${message}`;
}

async function main() {
  const mode = readArguments();
  if (!mode) return;

  loadLocalEnvironment();
  const connectionString = requireEnvironment("DATABASE_URL");
  const database = postgres(connectionString, {
    max: 1,
    connect_timeout: 5,
    idle_timeout: 10,
    prepare: false
  });
  try {
    if (mode === "resume") {
      if (!existsSync(recoveryPath)) {
        throw new Error("No protected recovery record exists to resume.");
      }
      const keys = readRecoveryRecord();
      const counts = await verifyDatabase(database, keys);
      updateLocalEnvironment(keys);
      unlinkSync(recoveryPath);
      console.log(
        `Verified and installed rotated keys for ${counts.reserves} reserves and ${counts.gasTanks} Gas Tanks.`
      );
      return;
    }

    const currentKeys = readCurrentKeys();
    requireDistinctKeys(currentKeys);
    if (mode === "check") {
      const counts = await verifyDatabase(database, currentKeys);
      console.log(
        `Verified ${counts.reserves} reserves and ${counts.gasTanks} Gas Tanks; no changes made.`
      );
      return;
    }

    const nextKeys = createNextKeys(currentKeys);
    requireDistinctKeys(nextKeys);
    writeRecoveryRecord(nextKeys);
    try {
      const counts = await rotateDatabase(
        database,
        currentKeys,
        nextKeys
      );
      updateLocalEnvironment(nextKeys);
      unlinkSync(recoveryPath);
      console.log(
        `Rewrapped ${counts.reserves} reserves and ${counts.gasTanks} Gas Tanks, verified recovery backups, and updated both local environment files.`
      );
    } catch (error) {
      console.error(
        `Key rotation did not finish (recovery record retained; error ${safeFailureCode(error)}). Verify the database with pnpm keys:rotate -- --resume before retrying.`
      );
      process.exitCode = 1;
    }
  } finally {
    await database.end({ timeout: 5 });
  }
}

main().catch((error) => {
  console.error(`Envelope-key operation failed (error ${safeFailureCode(error)}).`);
  process.exitCode = 1;
});
