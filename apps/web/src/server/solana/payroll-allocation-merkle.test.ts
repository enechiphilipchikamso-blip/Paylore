import { describe, expect, it } from "vitest";
import {
  buildPayrollAllocationMerkleTree,
  verifyPayrollAllocationMerkleProof
} from "./payroll-allocation-merkle";

function inputs(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    claimId: (index + 1).toString(16).padStart(2, "0").repeat(32),
    contributorAddress: [
      "11111111111111111111111111111111",
      "Vote111111111111111111111111111111111111111",
      "SysvarRent111111111111111111111111111111111",
      "Stake11111111111111111111111111111111111111",
      "ComputeBudget111111111111111111111111111111"
    ][index % 5]!,
    amountCommitment: (index + 16).toString(16).padStart(2, "0").repeat(32)
  }));
}

describe("payroll allocation Merkle commitment", () => {
  it.each([1, 2, 3, 4, 5, 9])("proves every claim belongs to the root for %i allocations", (count) => {
    const rows = inputs(count);
    const tree = buildPayrollAllocationMerkleTree(rows);
    expect(tree.proofs).toHaveLength(count);
    for (const proof of tree.proofs) {
      const row = rows.find((item) => item.claimId === proof.claimId)!;
      expect(verifyPayrollAllocationMerkleProof({
        allocationCommitment: tree.allocationCommitment,
        leaf: row,
        leafIndex: proof.leafIndex,
        siblings: proof.siblings
      })).toBe(true);
    }
  });

  it("changes the run root when an amount commitment or contributor changes", () => {
    const rows = inputs(3);
    const root = buildPayrollAllocationMerkleTree(rows).allocationCommitment;
    expect(buildPayrollAllocationMerkleTree(rows.map((row, index) =>
      index === 0 ? { ...row, amountCommitment: "fe".repeat(32) } : row
    )).allocationCommitment).not.toBe(root);
    expect(buildPayrollAllocationMerkleTree(rows.map((row, index) =>
      index === 0 ? { ...row, contributorAddress: "SysvarRent111111111111111111111111111111111" } : row
    )).allocationCommitment).not.toBe(root);
  });

  it("rejects tampered amount commitments, proof siblings, indices and duplicate claims", () => {
    const rows = inputs(3);
    const tree = buildPayrollAllocationMerkleTree(rows);
    const proof = tree.proofs[1]!;
    expect(verifyPayrollAllocationMerkleProof({
      allocationCommitment: tree.allocationCommitment,
      leaf: { ...rows[1]!, amountCommitment: "ff".repeat(32) },
      leafIndex: proof.leafIndex,
      siblings: proof.siblings
    })).toBe(false);
    expect(verifyPayrollAllocationMerkleProof({
      allocationCommitment: tree.allocationCommitment,
      leaf: rows[1]!,
      leafIndex: proof.leafIndex,
      siblings: proof.siblings.map((sibling, index) => index === 0 ? "ff".repeat(32) : sibling)
    })).toBe(false);
    expect(verifyPayrollAllocationMerkleProof({
      allocationCommitment: tree.allocationCommitment,
      leaf: rows[1]!,
      leafIndex: 0,
      siblings: proof.siblings
    })).toBe(false);
    expect(() => buildPayrollAllocationMerkleTree([rows[0]!, rows[0]!])).toThrow("must be unique");
  });
});
