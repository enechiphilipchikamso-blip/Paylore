import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  auditPayrollProgramIdl,
  EXPECTED_PAYLORE_PROGRAM_ID
} from "./audit-payroll-program-idl.mjs";

export const PAYLORE_DEVNET_GENESIS_HASH =
  "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG";
export const BPF_UPGRADEABLE_LOADER_ID =
  "BPFLoaderUpgradeab1e11111111111111111111111";
const DEVNET_RPC_URL = "https://api.devnet.solana.com";
const PROGRAM_STATE = 2;
const PROGRAM_DATA_STATE = 3;

function fail(message) {
  throw new Error(message);
}

function decodeBase58(value) {
  if (typeof value !== "string" || value.length === 0) fail("A public key is malformed.");
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) fail("A public key is malformed.");
    number = number * 58n + BigInt(digit);
  }
  const bytes = [];
  while (number > 0n) {
    bytes.unshift(Number(number & 255n));
    number >>= 8n;
  }
  for (const character of value) {
    if (character !== "1") break;
    bytes.unshift(0);
  }
  const result = Uint8Array.from(bytes);
  if (result.length !== 32) fail("A public key has an invalid byte length.");
  return result;
}

function encodeBase58(bytes) {
  let number = 0n;
  for (const byte of bytes) number = number * 256n + BigInt(byte);
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = "";
  while (number > 0n) {
    value = alphabet[Number(number % 58n)] + value;
    number /= 58n;
  }
  let zeroes = 0;
  while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes++;
  return "1".repeat(zeroes) + value;
}

function accountBytes(account, label) {
  if (!account || typeof account !== "object" || Array.isArray(account)) {
    fail(label + " account is not present on Devnet.");
  }
  if (!Array.isArray(account.data) || typeof account.data[0] !== "string" ||
      account.data[1] !== "base64") {
    fail(label + " account data is not base64 encoded.");
  }
  const bytes = Buffer.from(account.data[0], "base64");
  if (bytes.toString("base64") !== account.data[0]) {
    fail(label + " account data is malformed.");
  }
  return new Uint8Array(bytes);
}

export function parseProgramAccount(programAccount, programId) {
  if (programAccount?.owner !== BPF_UPGRADEABLE_LOADER_ID || programAccount.executable !== true) {
    fail("The configured Paylore Program account is absent, not executable, or owned by another loader.");
  }
  const data = accountBytes(programAccount, "Program");
  if (data.length !== 36 || new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true) !== PROGRAM_STATE) {
    fail("The Paylore Program account does not contain the expected upgradeable-loader Program state.");
  }
  decodeBase58(programId);
  return encodeBase58(data.subarray(4, 36));
}

export function parseProgramData(programDataAccount, artifactBytes, expectedUpgradeAuthority) {
  if (programDataAccount?.owner !== BPF_UPGRADEABLE_LOADER_ID || programDataAccount.executable !== false) {
    fail("The Paylore ProgramData account is absent or owned by another loader.");
  }
  const data = accountBytes(programDataAccount, "ProgramData");
  if (data.length < 13 || new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0, true) !== PROGRAM_DATA_STATE) {
    fail("The ProgramData account does not contain the expected upgradeable-loader state.");
  }

  const deployedSlotValue = new DataView(data.buffer, data.byteOffset, data.byteLength).getBigUint64(4, true);
  if (deployedSlotValue > BigInt(Number.MAX_SAFE_INTEGER)) {
    fail("The ProgramData deployment slot cannot be represented safely.");
  }
  const deployedSlot = Number(deployedSlotValue);
  const authorityOption = data[12];
  let authorityOffset = 13;
  let upgradeAuthority = null;
  if (authorityOption === 1) {
    if (data.length < 45) fail("The ProgramData upgrade-authority field is truncated.");
    upgradeAuthority = encodeBase58(data.subarray(13, 45));
    authorityOffset = 45;
  } else if (authorityOption !== 0) {
    fail("The ProgramData upgrade-authority flag is malformed.");
  }

  if (expectedUpgradeAuthority !== undefined && expectedUpgradeAuthority !== null &&
      expectedUpgradeAuthority !== upgradeAuthority) {
    fail("The deployed Payroll Program upgrade authority differs from PAYLORE_EXPECTED_PROGRAM_UPGRADE_AUTHORITY.");
  }
  if (!(artifactBytes instanceof Uint8Array) || artifactBytes.length === 0) {
    fail("The local Payroll Program executable is empty.");
  }
  const deployedExecutable = data.subarray(authorityOffset);
  if (deployedExecutable.length < artifactBytes.length) {
    fail("The deployed Payroll Program executable is shorter than the local build artifact.");
  }
  for (let index = 0; index < artifactBytes.length; index++) {
    if (deployedExecutable[index] !== artifactBytes[index]) {
      fail("The local Payroll Program executable does not match the deployed Devnet bytecode.");
    }
  }
  for (let index = artifactBytes.length; index < deployedExecutable.length; index++) {
    if (deployedExecutable[index] !== 0) {
      fail("Unexpected non-zero bytes follow the local executable in ProgramData; binary parity is not established.");
    }
  }

  return {
    deployedSlot,
    upgradeAuthority,
    artifactBytes: artifactBytes.length,
    artifactSha256: createHash("sha256").update(artifactBytes).digest("hex")
  };
}

async function rpcRequest(rpcUrl, method, params, { fetchImpl = fetch, headers = {} } = {}) {
  let response;
  try {
    response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      cache: "no-store",
      signal: AbortSignal.timeout(15_000)
    });
  } catch {
    fail("The configured Devnet RPC could not be reached.");
  }
  if (!response?.ok) fail("The configured Devnet RPC rejected a read-only verification request.");
  let envelope;
  try {
    envelope = await response.json();
  } catch {
    fail("The configured Devnet RPC returned invalid JSON.");
  }
  if (!envelope || typeof envelope !== "object" || envelope.error ||
      !Object.hasOwn(envelope, "result")) {
    fail("The configured Devnet RPC returned an invalid or unsuccessful JSON-RPC response.");
  }
  return envelope.result;
}

function rpcOptions(env) {
  let url;
  try {
    url = new URL(env.PAYLORE_RPC_PRIMARY_URL || DEVNET_RPC_URL);
  } catch {
    fail("The configured Solana RPC URL is invalid.");
  }
  if (url.protocol !== "https:") fail("Devnet program verification requires an HTTPS RPC endpoint.");
  const provider = String(env.PAYLORE_RPC_PRIMARY_PROVIDER || "direct").toLowerCase();
  const headers = {};
  if (provider === "helius" && env.PAYLORE_RPC_PRIMARY_API_KEY) {
    url.searchParams.set("api-key", env.PAYLORE_RPC_PRIMARY_API_KEY);
  } else if (provider === "quicknode" && env.PAYLORE_RPC_PRIMARY_API_KEY) {
    headers["x-api-key"] = env.PAYLORE_RPC_PRIMARY_API_KEY;
  }
  return { url: url.toString(), headers };
}

/** Checks cluster identity before reading the existing program and compares its finalized bytes to the local artifact. */
export async function verifyDeployedProgramBytecodeOnDevnet({
  rpcUrl = DEVNET_RPC_URL,
  rpcHeaders = {},
  fetchImpl = fetch,
  programId = EXPECTED_PAYLORE_PROGRAM_ID,
  artifactBytes,
  expectedUpgradeAuthority
}) {
  if (programId !== EXPECTED_PAYLORE_PROGRAM_ID) {
    fail("The Paylore Payroll Program ID must remain the existing approved Devnet address.");
  }

  const genesisHash = await rpcRequest(rpcUrl, "getGenesisHash", [], { fetchImpl, headers: rpcHeaders });
  if (genesisHash !== PAYLORE_DEVNET_GENESIS_HASH) {
    fail("The configured RPC does not identify the approved Solana Devnet cluster; no program verification was performed.");
  }

  const programResponse = await rpcRequest(rpcUrl, "getAccountInfo", [
    programId, { commitment: "finalized", encoding: "base64" }
  ], { fetchImpl, headers: rpcHeaders });
  const programDataAddress = parseProgramAccount(programResponse?.value, programId);
  const programDataResponse = await rpcRequest(rpcUrl, "getAccountInfo", [
    programDataAddress, { commitment: "finalized", encoding: "base64" }
  ], { fetchImpl, headers: rpcHeaders });
  const metadata = parseProgramData(
    programDataResponse?.value,
    artifactBytes,
    expectedUpgradeAuthority
  );

  return {
    status: "devnet_program_bytecode_verified",
    cluster: "devnet",
    programId,
    programDataAddress,
    genesisHash,
    ...metadata
  };
}

/** Read-only verification of Devnet identity, generated ABI, deployed loader metadata, and exact program bytes. */
export async function verifyPayrollProgramDevnet(input) {
  auditPayrollProgramIdl({
    idl: input.idl,
    source: input.source,
    anchorConfig: input.anchorConfig
  });
  const binary = await verifyDeployedProgramBytecodeOnDevnet(input);
  return {
    ...binary,
    status: "devnet_program_bytecode_and_source_idl_verified"
  };
}

function readLocalInputs({ idlPath, sourcePath, anchorConfigPath, artifactPath }) {
  let idl;
  try {
    idl = JSON.parse(readFileSync(idlPath, "utf8"));
  } catch (error) {
    throw new Error("Unable to read generated Payroll Program IDL. Run anchor build before this audit.", { cause: error });
  }
  return {
    idl,
    source: readFileSync(sourcePath, "utf8"),
    anchorConfig: readFileSync(anchorConfigPath, "utf8"),
    artifactBytes: new Uint8Array(readFileSync(artifactPath))
  };
}

async function main() {
  const artifactPath = resolve(process.argv[2] ?? "target/deploy/paylore_payroll.so");
  const idlPath = resolve(process.argv[3] ?? "target/idl/paylore_payroll.json");
  const sourcePath = resolve(process.argv[4] ?? "programs/payroll/src/lib.rs");
  const anchorConfigPath = resolve(process.argv[5] ?? "Anchor.toml");
  const local = readLocalInputs({ idlPath, sourcePath, anchorConfigPath, artifactPath });
  const rpc = rpcOptions(process.env);
  const expectedUpgradeAuthority = process.env.PAYLORE_EXPECTED_PROGRAM_UPGRADE_AUTHORITY || undefined;
  const result = await verifyPayrollProgramDevnet({
    rpcUrl: rpc.url,
    rpcHeaders: rpc.headers,
    ...local,
    expectedUpgradeAuthority
  });
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : "Devnet program verification failed.") + "\n");
    process.exitCode = 1;
  });
}
