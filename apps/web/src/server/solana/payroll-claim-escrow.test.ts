import { describe, expect, it, vi } from "vitest";
import { address, generateKeyPairSigner } from "@solana/kit";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS } from "@solana-program/zk-elgamal-proof";
import { AeKey, ElGamalKeypair } from "@solana/zk-sdk/bundler";

vi.mock("@paylore/database", () => ({}));
vi.mock("../config", () => ({ loadPayloreConfig: vi.fn() }));
vi.mock("../reserve", () => ({ withWorkspaceReserveKey: vi.fn() }));
vi.mock("../gas-tank", () => ({ withWorkspaceGasTankKey: vi.fn() }));
vi.mock("./rpc-configured", () => ({ configuredRpcEndpoint: () => "http://127.0.0.1:8899" }));

import { getEscrowConfidentialSetupInstructionPlan } from "./payroll-claim-escrow";

const ASSOCIATED_TOKEN_PROGRAM_ADDRESS = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL";

function planInstructions(plan: unknown): Array<{ programAddress: string; accounts?: Array<{ address: string }> }> {
  const node = plan as { kind: string; plans?: unknown[]; instruction?: { programAddress: string } };
  if (node.kind === "single") return [node.instruction as { programAddress: string }];
  return (node.plans ?? []).flatMap(planInstructions);
}

describe("escrow confidential account setup plan", () => {
  it("configures the existing keypair escrow account without an associated-token create", async () => {
    const payer = await generateKeyPairSigner();
    const owner = await generateKeyPairSigner();
    const token = (await generateKeyPairSigner()).address;
    const mint = address("4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU");
    const elgamal = new ElGamalKeypair();
    const aesKey = new AeKey();
    try {
      const plan = await getEscrowConfidentialSetupInstructionPlan({
        rpc: {} as never,
        payer,
        owner,
        mint,
        token,
        elgamalKeypair: elgamal,
        aesKey,
        includeConfidentialTransferFeeAmount: false
      });
      expect((plan as { kind: string }).kind).toBe("sequential");
      expect((plan as { divisible?: boolean }).divisible).toBe(false);
      const instructions = planInstructions(plan);
      expect(instructions.map((instruction) => instruction.programAddress)).toEqual([
        TOKEN_2022_PROGRAM_ADDRESS,
        TOKEN_2022_PROGRAM_ADDRESS,
        ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS
      ]);
      expect(instructions.some((instruction) =>
        instruction.programAddress === ASSOCIATED_TOKEN_PROGRAM_ADDRESS
      )).toBe(false);
      expect(instructions[0]?.accounts?.[0]?.address).toBe(token);
      expect(instructions[1]?.accounts?.[0]?.address).toBe(token);
    } finally {
      elgamal.free();
      aesKey.free();
    }
  });
});
