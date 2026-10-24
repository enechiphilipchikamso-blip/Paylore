import "server-only";

import { createHash } from "node:crypto";
import {
  address,
  getAddressEncoder,
  getProgramDerivedAddress
} from "@solana/kit";
import { loadPayloreConfig } from "../config";
import { readSolanaRpc } from "./rpc";

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const textEncoder = new TextEncoder();

type ProgramInstruction = {
  programId?: unknown;
  accounts?: unknown;
  data?: unknown;
};

type ParsedTransaction = {
  slot?: unknown;
  transaction?: {
    signatures?: unknown;
    message?: {
      accountKeys?: unknown;
      instructions?: unknown;
    };
  };
  meta?: { err?: unknown } | null;
} | null;

export type ExpectedPayrollClaim = {
  claimId: string;
  claimAddress: string;
  contributorAddress: string;
  amountCommitment: string;
};

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function decodeBase58(value: string): Uint8Array {
  let number = 0n;
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) throw new Error("Transaction instruction data is invalid.");
    number = number * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (number > 0n) {
    bytes.unshift(Number(number & 0xffn));
    number >>= 8n;
  }
  for (const character of value) {
    if (character !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

function decodeHex32(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error("The payroll run contains an invalid claim identifier.");
  }
  return Uint8Array.from(value.match(/.{2}/g)!, (byte) =>
    Number.parseInt(byte, 16)
  );
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

async function deriveWorkspaceAddress(
  authorityAddress: string,
  workspaceId: string,
  programId: string
) {
  const workspaceSeed = createHash("sha256")
    .update(`paylore:workspace:v1:${workspaceId}`)
    .digest();
  const [workspace] = await getProgramDerivedAddress({
    programAddress: address(programId),
    seeds: [
      textEncoder.encode("workspace"),
      getAddressEncoder().encode(address(authorityAddress)),
      workspaceSeed
    ]
  });
  return { workspace, workspaceSeed };
}

async function deriveClaimAddress(
  workspace: ReturnType<typeof address>,
  contributorAddress: string,
  claimId: Uint8Array,
  programId: string
) {
  const [claim, bump] = await getProgramDerivedAddress({
    programAddress: address(programId),
    seeds: [
      textEncoder.encode("claim"),
      getAddressEncoder().encode(workspace),
      getAddressEncoder().encode(address(contributorAddress)),
      claimId
    ]
  });
  return { address: claim, bump };
}

async function instructionDiscriminator(namespace: string): Promise<Uint8Array> {
  return createHash("sha256")
    .update(namespace)
    .digest()
    .subarray(0, 8);
}

function decodeBase64AccountData(value: unknown): Uint8Array | null {
  if (
    !Array.isArray(value) ||
    typeof value[0] !== "string" ||
    value[1] !== "base64"
  ) {
    return null;
  }
  const bytes = Buffer.from(value[0], "base64");
  return bytes.toString("base64") === value[0] ? bytes : null;
}

function signedBy(accountKeys: unknown, walletAddress: string): boolean {
  if (!Array.isArray(accountKeys)) return false;
  return accountKeys.some((entry) => {
    const key = object(entry);
    return key?.pubkey === walletAddress && key.signer === true;
  });
}

export async function verifyPayrollClaimTransaction(input: {
  signature: string;
  authorityAddress: string;
  workspaceId: string;
  allocationCommitment: string;
  claims: ExpectedPayrollClaim[];
}): Promise<void> {
  const config = loadPayloreConfig();
  const programId = config.PAYLORE_PAYROLL_PROGRAM_ID;
  if (!programId) {
    throw new Error("The Devnet Payroll Program is not configured.");
  }
  if (input.claims.length === 0 || input.claims.length > 4) {
    throw new Error("The submitted payroll claim batch is invalid.");
  }
  const commitment = decodeHex32(input.allocationCommitment);
  const { workspace, workspaceSeed } = await deriveWorkspaceAddress(
    input.authorityAddress,
    input.workspaceId,
    programId
  );
  const transaction = await readSolanaRpc<ParsedTransaction>(
    "getTransaction",
    [
      input.signature,
      {
        encoding: "jsonParsed",
        commitment: "finalized",
        maxSupportedTransactionVersion: 0
      }
    ]
  );
  const tx = object(transaction);
  const meta = object(tx?.meta);
  const transactionBody = object(tx?.transaction);
  const message = object(transactionBody?.message);
  const signatures = transactionBody?.signatures;
  const accountKeys = message?.accountKeys;
  const instructions = message?.instructions;
  if (
    !tx ||
    !meta ||
    meta.err !== null ||
    typeof tx.slot !== "number" ||
    !Array.isArray(signatures) ||
    !signatures.includes(input.signature) ||
    !signedBy(accountKeys, input.authorityAddress) ||
    !Array.isArray(instructions)
  ) {
    throw new Error("The payroll claim transaction is not finalized successfully.");
  }

  const createClaimDiscriminator =
    await instructionDiscriminator("global:create_claim");
  const expectedClaims = new Map(
    await Promise.all(
      input.claims.map(async (claim) => {
        const claimId = decodeHex32(claim.claimId);
        const derivedClaim = await deriveClaimAddress(
          workspace,
          claim.contributorAddress,
          claimId,
          programId
        );
        if (derivedClaim.address !== claim.claimAddress) {
          throw new Error("The submitted Claim PDA does not match this allocation.");
        }
        return [claim.claimId, {
          ...claim,
          claimId,
          derivedClaim: derivedClaim.address,
          claimBump: derivedClaim.bump
        }] as const;
      })
    )
  );
  const matchedClaims = new Set<string>();
  for (const rawInstruction of instructions) {
    const instruction = object(rawInstruction) as ProgramInstruction | null;
    if (instruction?.programId !== programId) continue;
    if (
      typeof instruction.data !== "string" ||
      !Array.isArray(instruction.accounts) ||
      !instruction.accounts.every((account) => typeof account === "string")
    ) {
      throw new Error("The Payroll Program instruction is malformed.");
    }
    const data = decodeBase58(instruction.data);
    if (
      data.length >= 8 &&
      sameBytes(data.subarray(0, 8), createClaimDiscriminator)
    ) {
      if (data.length !== 104 || instruction.accounts.length !== 5) {
        throw new Error("The Claim PDA instruction has an invalid format.");
      }
      const claimId = Buffer.from(data.subarray(8, 40)).toString("hex");
      const expected = expectedClaims.get(claimId);
      const accounts = instruction.accounts as string[];
      if (
        !expected ||
        accounts[0] !== input.authorityAddress ||
        accounts[1] !== expected.contributorAddress ||
        accounts[2] !== workspace ||
        accounts[3] !== expected.derivedClaim ||
        !sameBytes(data.subarray(40, 72), commitment) ||
        !sameBytes(data.subarray(72, 104), decodeHex32(expected.amountCommitment))
      ) {
        throw new Error("The on-chain claim instruction does not match the approved payroll.");
      }
      matchedClaims.add(claimId);
    }
  }
  if (matchedClaims.size !== expectedClaims.size) {
    throw new Error("The finalized transaction does not contain every expected claim.");
  }

  const claimStateDiscriminator = await instructionDiscriminator(
    "account:ClaimState"
  );
  const workspaceBytes = Uint8Array.from(
    getAddressEncoder().encode(workspace)
  );
  for (const expected of expectedClaims.values()) {
    const contributorBytes = Uint8Array.from(
      getAddressEncoder().encode(address(expected.contributorAddress))
    );
    const accountInfo = await readSolanaRpc<{
      value: {
        owner: string;
        executable: boolean;
        data: unknown;
      } | null;
    }>("getAccountInfo", [
      expected.claimAddress,
      { commitment: "finalized", encoding: "base64" }
    ]);
    const account = accountInfo.value;
    const data = decodeBase64AccountData(account?.data);
    if (
      !account ||
      account.owner !== programId ||
      account.executable ||
      !data ||
      data.length !== 170 ||
      !sameBytes(data.subarray(0, 8), claimStateDiscriminator) ||
      !sameBytes(data.subarray(8, 40), workspaceBytes) ||
      !sameBytes(data.subarray(40, 72), contributorBytes) ||
      !sameBytes(data.subarray(72, 104), expected.claimId) ||
      !sameBytes(data.subarray(104, 136), commitment) ||
      !sameBytes(data.subarray(136, 168), decodeHex32(expected.amountCommitment)) ||
      data[168] !== 0 ||
      data[169] !== expected.claimBump
    ) {
      throw new Error(
        "The finalized Claim PDA account does not match the expected workspace, contributor, allocation, commitment, and unclaimed state."
      );
    }
  }
}

export async function verifyPayrollRecoveryTransaction(input: {
  signature: string;
  authorityAddress: string;
  workspaceId: string;
  contributorAddress: string;
  claimId: string;
  claimAddress: string;
  allocationCommitment: string;
  recoveryReasonCommitment: string;
}): Promise<void> {
  const config = loadPayloreConfig();
  const programId = config.PAYLORE_PAYROLL_PROGRAM_ID;
  if (!programId) {
    throw new Error("The Devnet Payroll Program is not configured.");
  }
  const claimId = decodeHex32(input.claimId);
  const allocationCommitment = decodeHex32(input.allocationCommitment);
  const reasonCommitment = decodeHex32(input.recoveryReasonCommitment);
  const { workspace } = await deriveWorkspaceAddress(
    input.authorityAddress,
    input.workspaceId,
    programId
  );
  const claim = await deriveClaimAddress(
    workspace,
    input.contributorAddress,
    claimId,
    programId
  );
  if (claim.address !== input.claimAddress) {
    throw new Error("The recovery Claim PDA does not match the allocation.");
  }

  const transaction = await readSolanaRpc<ParsedTransaction>(
    "getTransaction",
    [
      input.signature,
      {
        encoding: "jsonParsed",
        commitment: "finalized",
        maxSupportedTransactionVersion: 0
      }
    ]
  );
  const tx = object(transaction);
  const meta = object(tx?.meta);
  const transactionBody = object(tx?.transaction);
  const message = object(transactionBody?.message);
  const signatures = transactionBody?.signatures;
  const accountKeys = message?.accountKeys;
  const instructions = message?.instructions;
  if (
    !tx ||
    !meta ||
    meta.err !== null ||
    typeof tx.slot !== "number" ||
    !Array.isArray(signatures) ||
    !signatures.includes(input.signature) ||
    !signedBy(accountKeys, input.authorityAddress) ||
    !Array.isArray(instructions)
  ) {
    throw new Error("The recovery transaction is not finalized successfully.");
  }

  const discriminator = await instructionDiscriminator("global:recover_claim");
  const matched = instructions.some((rawInstruction) => {
    const instruction = object(rawInstruction) as ProgramInstruction | null;
    if (
      instruction?.programId !== programId ||
      typeof instruction.data !== "string" ||
      !Array.isArray(instruction.accounts) ||
      !instruction.accounts.every((account) => typeof account === "string")
    ) {
      return false;
    }
    const data = decodeBase58(instruction.data);
    const accounts = instruction.accounts as string[];
    return (
      data.length === 40 &&
      sameBytes(data.subarray(0, 8), discriminator) &&
      sameBytes(data.subarray(8), reasonCommitment) &&
      accounts.length === 4 &&
      accounts[0] === input.authorityAddress &&
      accounts[1] === input.contributorAddress &&
      accounts[2] === workspace &&
      accounts[3] === claim.address
    );
  });
  if (!matched) {
    throw new Error("The finalized transaction does not perform this Claim PDA recovery.");
  }

  const claimStateDiscriminator = await instructionDiscriminator("account:ClaimState");
  const accountInfo = await readSolanaRpc<{
    value: { owner: string; executable: boolean; data: unknown } | null;
  }>("getAccountInfo", [
    claim.address,
    { commitment: "finalized", encoding: "base64" }
  ]);
  const account = object(accountInfo)?.value;
  const accountRecord = object(account);
  const data = decodeBase64AccountData(accountRecord?.data);
  const workspaceBytes = getAddressEncoder().encode(workspace);
  const contributorBytes = getAddressEncoder().encode(address(input.contributorAddress));
  if (
    !accountRecord ||
    accountRecord.owner !== programId ||
    accountRecord.executable !== false ||
    !data ||
    data.length !== 170 ||
    !sameBytes(data.subarray(0, 8), claimStateDiscriminator) ||
    !sameBytes(data.subarray(8, 40), workspaceBytes) ||
    !sameBytes(data.subarray(40, 72), contributorBytes) ||
    !sameBytes(data.subarray(72, 104), claimId) ||
    !sameBytes(data.subarray(104, 136), allocationCommitment) ||
    data[168] !== 2 ||
    data[169] !== claim.bump
  ) {
    throw new Error(
      "The finalized Claim PDA is not in the expected RECOVERED state for this allocation."
    );
  }
}
