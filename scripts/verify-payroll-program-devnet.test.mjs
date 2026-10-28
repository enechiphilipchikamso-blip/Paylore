import test from "node:test";
import assert from "node:assert/strict";
import {
  EXPECTED_PAYLORE_PROGRAM_ID
} from "./audit-payroll-program-idl.mjs";
import {
  BPF_UPGRADEABLE_LOADER_ID,
  parseProgramAccount,
  parseProgramData,
  PAYLORE_DEVNET_GENESIS_HASH,
  verifyDeployedProgramBytecodeOnDevnet,
  verifyPayrollProgramDevnet
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
    artifactSha256: "1ce1805693fc7e6df020e40f78385981789a078c681dbbcbd1551be1c3939a3e"
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

test("rejects a deployed executable shorter than the local artifact", () => {
  const shorterArtifact = artifact.subarray(0, artifact.length - 1);
  const programData = account(
    BPF_UPGRADEABLE_LOADER_ID,
    false,
    programDataAccountData(shorterArtifact, authorityBytes, { padding: 0 })
  );

  assert.throws(
    () => parseProgramData(programData, artifact, upgradeAuthority),
    /shorter than the local build artifact \(7 bytes deployed, 8 bytes local\)/
  );
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

test("verifies finalized Devnet program bytes through read-only RPC calls only", async () => {
  const programAccount = account(
    BPF_UPGRADEABLE_LOADER_ID,
    true,
    programAccountData(programDataAddress)
  );
  const programDataAccount = account(
    BPF_UPGRADEABLE_LOADER_ID,
    false,
    programDataAccountData(artifact, authorityBytes)
  );
  const requests = [];
  const fetchImpl = async (url, init) => {
    const request = JSON.parse(init.body);
    requests.push({ url, init, request });
    let result;
    if (request.method === "getGenesisHash") result = PAYLORE_DEVNET_GENESIS_HASH;
    else if (request.method === "getAccountInfo" && request.params[0] === EXPECTED_PAYLORE_PROGRAM_ID) {
      result = { context: { slot: 100 }, value: programAccount };
    } else if (request.method === "getAccountInfo" && request.params[0] === programDataAddress) {
      result = { context: { slot: 100 }, value: programDataAccount };
    } else {
      throw new Error("Unexpected non-read-only or unknown RPC method: " + request.method);
    }
    return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  const result = await verifyDeployedProgramBytecodeOnDevnet({
    rpcUrl: "https://rpc.devnet.example",
    rpcHeaders: { "x-api-key": "test-public-provider-key" },
    fetchImpl,
    artifactBytes: artifact,
    expectedUpgradeAuthority: upgradeAuthority
  });

  assert.equal(result.status, "devnet_program_bytecode_verified");
  assert.equal(result.cluster, "devnet");
  assert.equal(result.programId, EXPECTED_PAYLORE_PROGRAM_ID);
  assert.equal(result.programDataAddress, programDataAddress);
  assert.equal(result.deployedSlot, 123);
  assert.deepEqual(requests.map((item) => item.request.method), [
    "getGenesisHash", "getAccountInfo", "getAccountInfo"
  ]);
  assert.equal(requests[1].request.params[1].commitment, "finalized");
  assert.equal(requests[2].request.params[1].commitment, "finalized");
  assert.equal(requests[0].init.method, "POST");
  assert.equal(requests[0].init.headers["x-api-key"], "test-public-provider-key");
});

test("refuses to inspect or compare program bytes when RPC genesis hash is not Devnet", async () => {
  const requests = [];
  const fetchImpl = async (_url, init) => {
    const request = JSON.parse(init.body);
    requests.push(request);
    return new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      result: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d"
    }), {
      status: 200,
      headers: { "content-type": "application/json" }
    });
  };

  await assert.rejects(
    verifyDeployedProgramBytecodeOnDevnet({
      rpcUrl: "https://rpc.mainnet.example",
      fetchImpl,
      artifactBytes: artifact
    }),
    /does not identify the approved Solana Devnet cluster/
  );
  assert.deepEqual(requests.map((request) => request.method), ["getGenesisHash"]);
});

test("rejects stale source/IDL parity before making any network request", async () => {
  let requests = 0;
  const fetchImpl = async () => {
    requests++;
    throw new Error("A mismatched local ABI must be rejected before network access.");
  };

  await assert.rejects(
    verifyPayrollProgramDevnet({
      rpcUrl: "https://rpc.devnet.example",
      fetchImpl,
      idl: { address: EXPECTED_PAYLORE_PROGRAM_ID, instructions: [] },
      source: "",
      anchorConfig: "",
      artifactBytes: artifact
    }),
    /Payroll Program source declare_id/
  );
  assert.equal(requests, 0);
});
