import test from "node:test";
import assert from "node:assert/strict";
import {
  BPF_UPGRADEABLE_LOADER_ID,
  EXPECTED_PAYLORE_PROGRAM_ID
} from "./audit-payroll-program-idl.mjs";
import {
  parseProgramAccount,
  parseProgramData
} from "./verify-payroll-program-devnet.mjs";

function encodeBase58(bytes) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = 0n;
  for (const byte of bytes) number = number * 256n + BigInt(byte);
  let value = "";
  while (number > 0n) {
    value = alphabet[Number(number % 58n)] + value;
    number /= 58n;
  }
  let zeroes = 0;
  while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes++;
  return "1".repeat(zeroes) + value;
}

function decodeBase58(value) {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = 0n;
  for (const character of value) number = number * 58n + BigInt(alphabet.indexOf(character));
  const decoded = [];
  while (number > 0n) {
    decoded.unshift(Number(number & 255n));
    number >>= 8n;
  }
  let zeroes = 0;
  while (zeroes < value.length && value[zeroes] === "1") zeroes++;
  return Buffer.from([...Array(zeroes).fill(0), ...decoded]);
}

function account(owner, executable, bytes) {
  return {
    owner,
    executable,
    data: [Buffer.from(bytes).toString("base64"), "base64"]
  };
}

function programAccountData(programDataAddress) {
  const bytes = Buffer.alloc(36);
  bytes.writeUInt32LE(2, 0);
  decodeBase58(programDataAddress).copy(bytes, 4);
  return bytes;
}

function programDataAccountData(artifact, authorityBytes, { slot = 123n, padding = 16, authority = true } = {}) {
  const headerBytes = authority ? 45 : 13;
  const bytes = Buffer.alloc(headerBytes + artifact.length + padding);
  bytes.writeUInt32LE(3, 0);
  bytes.writeBigUInt64LE(slot, 4);
  bytes[12] = authority ? 1 : 0;
  if (authority) authorityBytes.copy(bytes, 13);
  Buffer.from(artifact).copy(bytes, headerBytes);
  return bytes;
}

const programDataAddress = encodeBase58(Buffer.alloc(32, 13));
const authorityBytes = Buffer.alloc(32, 7);
const upgradeAuthority = encodeBase58(authorityBytes);
const artifact = Uint8Array.from([0x7f, 0x45, 0x4c, 0x46, 0x01, 0x02, 0x03, 0x04]);

test("resolves the ProgramData pointer from the existing executable Devnet program", () => {
  const program = account(
    BPF_UPGRADEABLE_LOADER_ID,
    true,
    programAccountData(programDataAddress)
  );

  assert.equal(
    parseProgramAccount(program, EXPECTED_PAYLORE_PROGRAM_ID),
    programDataAddress
  );
});

test("rejects a program account owned by a different loader", () => {
  const program = account("11111111111111111111111111111111", true, programAccountData(programDataAddress));
  assert.throws(
    () => parseProgramAccount(program, EXPECTED_PAYLORE_PROGRAM_ID),
    /absent, not executable, or owned by another loader/
  );
});

test("rejects a non-executable or non-upgradeable program account", () => {
  assert.throws(
    () => parseProgramAccount(account(BPF_UPGRADEABLE_LOADER_ID, false, programAccountData(programDataAddress)), EXPECTED_PAYLORE_PROGRAM_ID),
    /absent, not executable/
  );
  const invalidState = programAccountData(programDataAddress);
  invalidState.writeUInt32LE(1, 0);
  assert.throws(
    () => parseProgramAccount(account(BPF_UPGRADEABLE_LOADER_ID, true, invalidState), EXPECTED_PAYLORE_PROGRAM_ID),
    /expected upgradeable-loader Program state/
  );
});

test("matches the entire local ELF and tolerates only zero-filled ProgramData capacity", () => {
  const programData = account(
    BPF_UPGRADEABLE_LOADER_ID,
    false,
    programDataAccountData(artifact, authorityBytes)
  );

  assert.deepEqual(parseProgramData(programData, artifact, upgradeAuthority), {
    deployedSlot: 123,
    upgradeAuthority,
    artifactBytes: artifact.length,
    artifactSha256: "b6c13b3b5fcd7c5a7c04a82c9b2c54c4813be7b2d24a3f4ce0f6dfcc7bf706ce"
  });
});

test("rejects a deployed ELF byte mismatch", () => {
  const artifactOnChain = Uint8Array.from(artifact);
  artifactOnChain[4] ^= 0xff;
  const programData = account(
    BPF_UPGRADEABLE_LOADER_ID,
    false,
    programDataAccountData(artifactOnChain, authorityBytes)
  );

  assert.throws(() => parseProgramData(programData, artifact, upgradeAuthority), /does not match the deployed Devnet bytecode/);
});

test("rejects non-zero trailing executable bytes instead of hashing a matching prefix only", () => {
  const data = programDataAccountData(artifact, authorityBytes);
  data[data.length - 1] = 1;

  assert.throws(
    () => parseProgramData(account(BPF_UPGRADEABLE_LOADER_ID, false, data), artifact, upgradeAuthority),
    /Unexpected non-zero bytes follow the local executable/
  );
});

test("rejects a different expected upgrade authority", () => {
  const programData = account(
    BPF_UPGRADEABLE_LOADER_ID,
    false,
    programDataAccountData(artifact, authorityBytes)
  );

  assert.throws(
    () => parseProgramData(programData, artifact, encodeBase58(Buffer.alloc(32, 8))),
    /differs from PAYLORE_EXPECTED_PROGRAM_UPGRADE_AUTHORITY/
  );
});

test("reports immutable programs without misreading an absent upgrade authority", () => {
  const programData = account(
    BPF_UPGRADEABLE_LOADER_ID,
    false,
    programDataAccountData(artifact, authorityBytes, { authority: false, padding: 0 })
  );

  assert.equal(parseProgramData(programData, artifact).upgradeAuthority, null);
});

test("rejects a malformed upgrade-authority tag", () => {
  const data = programDataAccountData(artifact, authorityBytes);
  data[12] = 2;
  assert.throws(
    () => parseProgramData(account(BPF_UPGRADEABLE_LOADER_ID, false, data), artifact),
    /upgrade-authority flag is malformed/
  );
});
