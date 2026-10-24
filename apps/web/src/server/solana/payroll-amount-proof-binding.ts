import type { InstructionPlan } from "@solana/kit";
import {
  CiphertextCommitmentEqualityProofData,
  ElGamalCiphertext,
  ElGamalKeypair,
  PedersenCommitment,
  PedersenOpening
} from "@solana/zk-sdk/bundler";
import { ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS } from "@solana-program/zk-elgamal-proof";
import type { PayrollAmountCommitmentMaterial } from "./payroll-amount-commitment";

export class PayrollAmountProofBindingError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "PayrollAmountProofBindingError";
  }
}

function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

/** Rebuilds the verified equality proof so its ciphertext and allocation use the same hiding commitment. */
export function bindAmountCommitmentProof(
  plan: InstructionPlan,
  elgamal: ElGamalKeypair,
  material: PayrollAmountCommitmentMaterial
): InstructionPlan {
  let matched = 0;
  if (!/^[0-9a-f]{64}$/i.test(material.amountCommitment)) {
    throw new PayrollAmountProofBindingError("confidential_amount_commitment_invalid");
  }
  const commitmentBytes = Uint8Array.from(
    material.amountCommitment.match(/.{2}/g)!,
    (byte) => Number.parseInt(byte, 16)
  );
  if (commitmentBytes.length !== 32) {
    throw new PayrollAmountProofBindingError("confidential_amount_commitment_invalid");
  }

  const rewrite = (current: InstructionPlan): InstructionPlan => {
    if (current.kind === "single") {
      const instruction = current.instruction;
      if (
        instruction.programAddress !== ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS ||
        instruction.data[0] !== 3
      ) return current;

      matched += 1;
      if (matched > 1) {
        throw new PayrollAmountProofBindingError("confidential_amount_proof_ambiguous");
      }
      const original = CiphertextCommitmentEqualityProofData.fromBytes(instruction.data.slice(1));
      const context = new Uint8Array(original.context().toBytes());
      const sourcePubkey = new Uint8Array(elgamal.pubkey().toBytes());
      if (
        context.length !== 128 ||
        !context.subarray(0, 32).every((byte, index) => byte === sourcePubkey[index])
      ) {
        throw new PayrollAmountProofBindingError("confidential_amount_proof_key_mismatch");
      }

      const ciphertext = ElGamalCiphertext.fromBytes(context.slice(32, 96));
      if (!ciphertext) {
        throw new PayrollAmountProofBindingError("confidential_amount_proof_ciphertext_invalid");
      }
      const opening = PedersenOpening.fromBytes(material.opening);
      const commitment = PedersenCommitment.fromBytes(commitmentBytes);
      const proof = new CiphertextCommitmentEqualityProofData(
        elgamal,
        ciphertext,
        commitment,
        opening,
        material.amountBaseUnits
      );
      proof.verify();
      const proofContext = new Uint8Array(proof.context().toBytes());
      if (!proofContext.subarray(96, 128).every((byte, index) => byte === commitmentBytes[index])) {
        throw new PayrollAmountProofBindingError("confidential_amount_proof_commitment_mismatch");
      }
      return {
        ...current,
        instruction: {
          ...instruction,
          data: concatBytes(Uint8Array.of(instruction.data[0]!), new Uint8Array(proof.toBytes()))
        }
      };
    }
    return { ...current, plans: current.plans.map(rewrite) } as InstructionPlan;
  };

  const bound = rewrite(plan);
  if (matched !== 1) {
    throw new PayrollAmountProofBindingError("confidential_amount_proof_missing");
  }
  return bound;
}
