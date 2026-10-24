import { createHmac } from "node:crypto";
import { PedersenCommitment, PedersenOpening } from "@solana/zk-sdk/bundler";

const SCALAR_ORDER = 7237005577332262213973186563042994240857116359379907606001950938285454250989n;
const U64_MAX = (1n << 64n) - 1n;

export type PayrollAmountCommitmentMaterial = {
  amountCommitment: string;
  opening: Uint8Array;
  amountBaseUnits: bigint;
};

function readSecret(secretHex: string): Buffer {
  if (!/^[0-9a-f]{64}$/i.test(secretHex)) {
    throw new Error("PAYLORE_PAYROLL_AMOUNT_COMMITMENT_SECRET must be a 32-byte hexadecimal key.");
  }
  return Buffer.from(secretHex, "hex");
}

function scalarToLittleEndian(value: bigint): Uint8Array {
  const output = new Uint8Array(32);
  let rest = value;
  for (let index = 0; index < output.length; index++) {
    output[index] = Number(rest & 0xffn);
    rest >>= 8n;
  }
  return output;
}

function deriveOpening(secret: Buffer, claimId: string, allocationCommitment: string): Uint8Array {
  const digest = createHmac("sha512", secret)
    .update("paylore:confidential-allocation-amount-opening:v1\0")
    .update(allocationCommitment.toLowerCase())
    .update("\0")
    .update(claimId.toLowerCase())
    .digest();
  const scalar = BigInt(`0x${Buffer.from(digest).reverse().toString("hex")}`) % SCALAR_ORDER;
  return scalarToLittleEndian(scalar === 0n ? 1n : scalar);
}

/** Creates a hiding Pedersen commitment for the exact private u64 allocation amount. */
export function derivePayrollAmountCommitmentMaterial(input: {
  amountBaseUnits: string;
  claimId: string;
  allocationCommitment: string;
  secretHex: string;
}): PayrollAmountCommitmentMaterial {
  if (!/^(0|[1-9][0-9]*)$/.test(input.amountBaseUnits)) {
    throw new Error("The payroll allocation amount must be a canonical unsigned integer.");
  }
  const amountBaseUnits = BigInt(input.amountBaseUnits);
  if (amountBaseUnits <= 0n || amountBaseUnits > U64_MAX) {
    throw new Error("The payroll allocation amount must fit a positive u64 value.");
  }
  if (!/^[0-9a-f]{64}$/i.test(input.claimId) || !/^[0-9a-f]{64}$/i.test(input.allocationCommitment)) {
    throw new Error("The claim ID and allocation commitment must each be 32-byte hexadecimal values.");
  }
  const secret = readSecret(input.secretHex);
  const opening = deriveOpening(secret, input.claimId, input.allocationCommitment);
  try {
    const pedersenOpening = PedersenOpening.fromBytes(opening);
    const commitment = PedersenCommitment.from(amountBaseUnits, pedersenOpening);
    return {
      amountCommitment: Buffer.from(commitment.toBytes()).toString("hex"),
      opening,
      amountBaseUnits
    };
  } finally {
    secret.fill(0);
  }
}
