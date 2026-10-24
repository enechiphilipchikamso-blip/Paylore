import { createHash } from "node:crypto";
import { address, getAddressEncoder } from "@solana/kit";

const LEAF_DOMAIN = Buffer.from("paylore:allocation-leaf:v1\0", "utf8");
const NODE_DOMAIN = Buffer.from("paylore:allocation-node:v1\0", "utf8");
export const MAX_ALLOCATION_PROOF_DEPTH = 16;

export type PayrollAllocationLeafInput = {
  claimId: string;
  contributorAddress: string;
  amountCommitment: string;
};

export type PayrollAllocationMerkleProof = {
  claimId: string;
  amountCommitment: string;
  leafIndex: number;
  siblings: string[];
};

export type PayrollAllocationMerkleTree = {
  allocationCommitment: string;
  proofs: PayrollAllocationMerkleProof[];
};

function decodeHex32(value: string, label: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`${label} must be a 32-byte hexadecimal value.`);
  }
  return Uint8Array.from(value.match(/.{2}/g)!, (byte) => Number.parseInt(byte, 16));
}

function hash(data: Uint8Array): Uint8Array {
  return createHash("sha256").update(data).digest();
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

export function payrollAllocationLeaf(input: PayrollAllocationLeafInput): Uint8Array {
  const contributor = getAddressEncoder().encode(address(input.contributorAddress));
  return hash(concat(
    LEAF_DOMAIN,
    decodeHex32(input.claimId, "Claim ID"),
    contributor,
    decodeHex32(input.amountCommitment, "Amount commitment")
  ));
}

/** Commits every hidden allocation amount to one deterministic run root and gives each claim its membership proof. */
export function buildPayrollAllocationMerkleTree(
  inputs: readonly PayrollAllocationLeafInput[]
): PayrollAllocationMerkleTree {
  if (inputs.length < 1) throw new Error("A payroll allocation tree must contain at least one claim.");
  const seenClaims = new Set<string>();
  for (const input of inputs) {
    const id = input.claimId.toLowerCase();
    if (seenClaims.has(id)) throw new Error("Payroll allocation claim IDs must be unique.");
    seenClaims.add(id);
  }

  const proofs = inputs.map((input) => ({
    claimId: input.claimId,
    amountCommitment: input.amountCommitment,
    leafIndex: 0,
    siblings: [] as string[]
  }));
  let layer = inputs.map(payrollAllocationLeaf);
  let indices = inputs.map((_, index) => index);

  while (layer.length > 1) {
    for (let index = 0; index < indices.length; index++) {
      const nodeIndex = indices[index]!;
      const siblingIndex = nodeIndex ^ 1;
      const sibling = layer[siblingIndex] ?? layer[nodeIndex]!;
      proofs[index]!.siblings.push(Buffer.from(sibling).toString("hex"));
      proofs[index]!.leafIndex = nodeIndex;
    }
    const next: Uint8Array[] = [];
    for (let index = 0; index < layer.length; index += 2) {
      const left = layer[index]!;
      const right = layer[index + 1] ?? left;
      next.push(hash(concat(NODE_DOMAIN, left, right)));
    }
    layer = next;
    indices = indices.map((index) => Math.floor(index / 2));
  }
  if (proofs.some((proof) => proof.siblings.length > MAX_ALLOCATION_PROOF_DEPTH)) {
    throw new Error("Payroll allocation tree exceeds the supported Merkle proof depth.");
  }
  for (let index = 0; index < proofs.length; index++) {
    proofs[index]!.leafIndex = index;
  }
  return {
    allocationCommitment: Buffer.from(layer[0]!).toString("hex"),
    proofs
  };
}

export function verifyPayrollAllocationMerkleProof(input: {
  allocationCommitment: string;
  leaf: PayrollAllocationLeafInput;
  leafIndex: number;
  siblings: readonly string[];
}): boolean {
  if (!Number.isSafeInteger(input.leafIndex) || input.leafIndex < 0 || input.siblings.length > MAX_ALLOCATION_PROOF_DEPTH) return false;
  let current = payrollAllocationLeaf(input.leaf);
  let index = input.leafIndex;
  try {
    for (const siblingHex of input.siblings) {
      const sibling = decodeHex32(siblingHex, "Merkle sibling");
      current = hash(index % 2 === 0
        ? concat(NODE_DOMAIN, current, sibling)
        : concat(NODE_DOMAIN, sibling, current));
      index = Math.floor(index / 2);
    }
    return index === 0 && Buffer.from(current).toString("hex") === input.allocationCommitment.toLowerCase();
  } catch {
    return false;
  }
}
