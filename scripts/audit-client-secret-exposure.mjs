#!/usr/bin/env node
import { readFile, readdir, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute, extname } from "node:path";

const defaultTargets = ["apps/web/.next/static"];
const sensitiveNamePattern = /(?:SECRET|ENVELOPE_KEY|API_KEY|DATABASE_URL|PRIVATE_KEY|ACCESS_TOKEN|PASSWORD|COOKIE)/i;
const sensitiveUrlKeys = new Set([
  "PAYLORE_RPC_PRIMARY_URL",
  "PAYLORE_RPC_SECONDARY_URL"
]);
const forbiddenBrowserNames = [
  "PAYLORE_RESERVE_ENVELOPE_KEY",
  "PAYLORE_GAS_TANK_ENVELOPE_KEY",
  "PAYLORE_HELIUS_WEBHOOK_SECRET",
  "PAYLORE_HELIUS_MANAGEMENT_API_KEY",
  "PAYLORE_RPC_PRIMARY_API_KEY",
  "PAYLORE_RPC_SECONDARY_API_KEY",
  "PAYLORE_RPC_SECONDARY_URL",
  "DATABASE_URL"
];
const targets = process.argv.slice(2).length
  ? process.argv.slice(2)
  : defaultTargets;
const root = process.cwd();

function parseEnvironmentFile(source) {
  const entries = new Map();
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
    if (!match) continue;
    let value = match[2].trim();
    if (value.length >= 2 && (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    )) {
      value = value.slice(1, -1);
    }
    if (value && value !== '""' && value !== "''") entries.set(match[1], value);
  }
  return entries;
}

async function loadEnvironment() {
  const values = new Map();
  for (const path of [
    ".env",
    ".env.local",
    ".env.production",
    ".env.production.local",
    "apps/web/.env",
    "apps/web/.env.local",
    "apps/web/.env.production",
    "apps/web/.env.production.local"
  ]) {
    try {
      const parsed = parseEnvironmentFile(await readFile(resolve(root, path), "utf8"));
      for (const [key, value] of parsed) values.set(key, value);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  for (const [key, value] of Object.entries(process.env)) {
    if (value) values.set(key, value);
  }
  return values;
}

function secretCandidates(environment) {
  const secrets = [];
  for (const [key, rawValue] of environment) {
    if (!sensitiveNamePattern.test(key) && !sensitiveUrlKeys.has(key)) continue;
    const value = rawValue.trim();
    if (value.length >= 8) secrets.push({ key, value });
    if (sensitiveUrlKeys.has(key)) {
      try {
        const url = new URL(value);
        for (const [partName, part] of [["username", url.username], ["password", url.password]]) {
          const decoded = decodeURIComponent(part);
          if (decoded.length >= 8) secrets.push({ key: key + " " + partName, value: decoded });
        }
      } catch {
        // Invalid provider URLs are validated by application configuration; scanning remains conservative.
      }
    }
  }
  return secrets.filter((entry, index, all) =>
    all.findIndex((candidate) => candidate.key === entry.key && candidate.value === entry.value) === index
  );
}

async function expandTarget(path, files) {
  const absolutePath = isAbsolute(path) ? path : resolve(root, path);
  let metadata;
  try {
    metadata = await stat(absolutePath);
  } catch {
    throw new Error(`Target does not exist: ${relative(root, absolutePath)}`);
  }
  if (metadata.isFile()) {
    files.push(absolutePath);
    return;
  }
  if (!metadata.isDirectory()) throw new Error(`Target is not a regular file or directory: ${relative(root, absolutePath)}`);
  const entries = await readdir(absolutePath, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const child = resolve(absolutePath, entry.name);
    if (entry.isDirectory()) await expandTarget(child, files);
    else if (entry.isFile()) files.push(child);
  }
}

const findings = [];
const files = [];
try {
  for (const target of targets) await expandTarget(target, files);
  const secrets = secretCandidates(await loadEnvironment());
  for (const path of files) {
    const bytes = await readFile(path);
    if (bytes.includes(0)) continue;
    const source = bytes.toString("utf8");
    const relativePath = relative(root, path);
    for (const secret of secrets) {
      if (source.includes(secret.value)) {
        findings.push(`${relativePath}: value from sensitive environment key ${secret.key}`);
      }
    }
    for (const name of forbiddenBrowserNames) {
      if (source.includes(name)) {
        findings.push(`${relativePath}: server-only configuration name ${name}`);
      }
    }
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : "Secret exposure audit could not read its targets.");
  process.exitCode = 2;
}

if (findings.length) {
  console.error("Sensitive content detected. No secret values are printed.");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else if (process.exitCode !== 2) {
  const scanned = files.map((path) => relative(root, path));
  console.log(`Secret exposure audit clear: scanned ${scanned.length} text/binary artifacts at requested paths. Source maps are included when present.`);
}
