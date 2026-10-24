import { createHmac } from "node:crypto";
import { PedersenCommitment, PedersenOpening } from "@solana/zk-sdk/bundler";

const SCALAR_ORDER = 7237005577332262213973186563042994240857116359379907606001950938285454250989n;
const U64_MAX = (1n << 64n) - 1n;

export type PayrollAmountCommitmentMaterial = {
  amountCommitmentLo: string;
  amountCommitmentHi: string;
  openingLo: Uint8Array;
  openingHi: Uint8Array;
  amountLo: bigint;
  amountHi: bigint;
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

function deriveOpening(secret: Buffer, claimId: string, allocationCommitment: string, limb: "lo" | "hi"): Uint8Array {
  const digest = createHmac("sha512", secret)
    .update("paylore:confidential-allocation-amount-opening:v1\0")
    .update(allocationCommitment.toLowerCase())
    .update("\0")
    .update(claimId.toLowerCase())
    .update("\0")
    .update(limb)
    .digest();
  const scalar = BigInt(`0x${Buffer.from(digest).reverse().toString("hex")}`) % SCALAR_ORDER;
  return scalarToLittleEndian(scalar === 0n ? 1n : scalar);
}

/** Creates hiding Pedersen commitments to the two limbs used by Token-2022's 64-bit confidential transfer proof. */
export function derivePayrollAmountCommitmentMaterial(input: {
  amountBaseUnits: string;
  claimId: string;
  allocationCommitment: string;
  secretHex: string;
}): PayrollAmountCommitmentMaterial {
  if (!/^(0|[1-9][0-9]*)$/.test(input.amountBaseUnits)) {
    throw new Error("The payroll allocation amount must be a canonical unsigned integer.");
  }
  if (BigInt(input.amountBaseUnits) <= 0n || BigInt(input.amountBaseUnits) > U64_MAX) {
    throw new Error("The payroll allocation amount must fit a positive u64 value.");
  }
  if (!/^[0-9a-f]{64}$/i.test(input.claimId) || !/^[0-9a-f]{64}$/i.test(input.allocationCommitment)) {
    throw new Error("The claim ID and allocation commitment must each be 32-byte hexadecimal values.");
  }
  const secret = readSecret(input.secretHex);
  const amount = BigInt(input.amountBaseUnits);
  const amountLo = amount & 0xffffn;
  const amountHi = amount >> 16n;
  const openingLo = deriveOpening(secret, input.claimId, input.allocationCommitment, "lo");
  const openingHi = deriveOpening(secret, input.claimId, input.allocationCommitment, "hi");
  const lo = PedersenOpening.fromBytes(openingLo);
  const hi = PedersenOpening.fromBytes(openingHi);
  try {
    const commitmentLo = PedersenCommitment.from(amountLo, lo);
    const commitmentHi = PedersenCommitment.from(amountHi, hi);
    return {
      amountCommitmentLo: Buffer.from(commitmentLo.toBytes()).toString("hex"),
      amountCommitmentHi: Buffer.from(commitmentHi.toBytes()).toString("hex"),
      openingLo,
      openingHi,
      amountLo,
      amountHi
    };
  } finally {
    secret.fill(0);
  }
}
