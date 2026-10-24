import { describe, expect, it } from "vitest";
import type { InstructionPlan } from "@solana/kit";
import {
  CiphertextCommitmentEqualityProofData,
  ElGamalKeypair,
  PedersenCommitment,
  PedersenOpening
} from "@solana/zk-sdk/bundler";
import { ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS } from "@solana-program/zk-elgamal-proof";
import { derivePayrollAmountCommitmentMaterial } from "./payroll-amount-commitment";
import { bindAmountCommitmentProof, PayrollAmountProofBindingError } from "./payroll-amount-proof-binding";

const secretHex = "42".repeat(32);
const claimId = "11".repeat(32);
const allocationCommitment = "22".repeat(32);
const amountBaseUnits = "1250000";

function equalityProofPlan(keypair: ElGamalKeypair, amount: bigint): InstructionPlan {
  const opening = PedersenOpening.new_rand();
  const commitment = PedersenCommitment.from(amount, opening);
  const ciphertext = keypair.pubkey().encryptU64(amount);
  const proof = new CiphertextCommitmentEqualityProofData(
    keypair, ciphertext, commitment, opening, amount
  );
  const proofBytes = new Uint8Array(proof.toBytes());
  const data = new Uint8Array(proofBytes.length + 1);
  data[0] = 3;
  data.set(proofBytes, 1);
  return {
    kind: "single",
    instruction: {
      programAddress: ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS,
      accounts: [],
      data
    }
  } as unknown as InstructionPlan;
}

describe("confidential amount proof binding", () => {
  it("rebuilds the verified equality proof using the precommitted amount", () => {
    const keypair = ElGamalKeypair.new_rand();
    const material = derivePayrollAmountCommitmentMaterial({
      amountBaseUnits, claimId, allocationCommitment, secretHex
    });
    const bound = bindAmountCommitmentProof(
      equalityProofPlan(keypair, BigInt(amountBaseUnits)),
      keypair,
      material
    );
    if (bound.kind !== "single") throw new Error("Expected a single proof instruction.");
    const data = bound.instruction.data;
    expect(data[0]).toBe(3);
    const proof = CiphertextCommitmentEqualityProofData.fromBytes(data.slice(1));
    expect(() => proof.verify()).not.toThrow();
    expect(Buffer.from(new Uint8Array(proof.context().toBytes()).slice(96, 128)).toString("hex"))
      .toBe(material.amountCommitment);
  });

  it("rejects a proof whose ciphertext uses another ElGamal key", () => {
    const source = ElGamalKeypair.new_rand();
    const wrongKey = ElGamalKeypair.new_rand();
    const material = derivePayrollAmountCommitmentMaterial({
      amountBaseUnits, claimId, allocationCommitment, secretHex
    });
    expect(() => bindAmountCommitmentProof(
      equalityProofPlan(source, BigInt(amountBaseUnits)), wrongKey, material
    )).toThrowError(PayrollAmountProofBindingError);
  });

  it("rejects a plan without a ciphertext-commitment equality proof", () => {
    const keypair = ElGamalKeypair.new_rand();
    const material = derivePayrollAmountCommitmentMaterial({
      amountBaseUnits, claimId, allocationCommitment, secretHex
    });
    expect(() => bindAmountCommitmentProof(
      { kind: "single", instruction: {
        programAddress: ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS,
        accounts: [], data: new Uint8Array([2])
      } } as unknown as InstructionPlan,
      keypair,
      material
    )).toThrowError(PayrollAmountProofBindingError);
  });
});
