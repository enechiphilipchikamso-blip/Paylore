import { describe, expect, it } from "vitest";
import { inspectGasTankFundingTransaction } from "./gas-tank-policy";

const payer = "payer-address";
const destination = "gas-tank-address";

function transaction(input: {
  signer?: string;
  source?: string;
  destination?: string;
  lamports?: string | number;
  instructionCount?: number;
  failed?: boolean;
  /** Unparsed instructions a wallet placed before the transfer. */
  leading?: Array<{ programId: string; accounts?: string[]; data?: string }>;
  /** Extra signer accounts besides the payer. */
  extraSigners?: string[];
}) {
  const instruction = {
    program: "system",
    parsed: {
      type: "transfer",
      info: {
        source: input.source ?? payer,
        destination: input.destination ?? destination,
        lamports: input.lamports ?? "50000000"
      }
    }
  };
  return {
    meta: { err: input.failed ? { InstructionError: [0, "Custom"] } : null },
    transaction: {
      message: {
        accountKeys: [
          { pubkey: input.signer ?? payer, signer: true },
          ...(input.extraSigners ?? []).map((pubkey) => ({ pubkey, signer: true }))
        ],
        instructions: [
          ...(input.leading ?? []).map((item) => ({
            programId: item.programId,
            accounts: item.accounts ?? [],
            data: item.data ?? ""
          })),
          ...Array.from(
            { length: input.instructionCount ?? 1 },
            () => instruction
          )
        ]
      }
    }
  };
}

const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";

describe("Gas Tank manual funding transaction policy", () => {
  it("accepts only a finalized exact system transfer from the session wallet", () => {
    expect(
      inspectGasTankFundingTransaction(transaction({}), {
        payer,
        destination
      })
    ).toEqual({ status: "confirmed", lamports: "50000000" });
  });

  it("records a transfer that the wallet wrapped with priority-fee instructions", () => {
    expect(
      inspectGasTankFundingTransaction(
        transaction({
          leading: [
            { programId: COMPUTE_BUDGET, data: "3GJzBfaeRmjF" },
            { programId: COMPUTE_BUDGET, data: "HnQLjD" }
          ]
        }),
        { payer, destination }
      )
    ).toEqual({ status: "confirmed", lamports: "50000000" });
  });

  it("rejects a transfer bundled with an instruction from a program that is not allowlisted", () => {
    expect(
      inspectGasTankFundingTransaction(
        transaction({
          leading: [{ programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }]
        }),
        { payer, destination }
      )
    ).toEqual({ status: "invalid" });
  });

  it("rejects a transaction that carries a second signer", () => {
    expect(
      inspectGasTankFundingTransaction(
        transaction({ extraSigners: ["another-signer"] }),
        { payer, destination }
      )
    ).toEqual({ status: "invalid" });
  });

  it("keeps an absent transaction pending", () => {
    expect(
      inspectGasTankFundingTransaction(null, { payer, destination })
    ).toEqual({ status: "pending" });
  });

  it.each([
    { signer: "other-wallet" },
    { source: "other-wallet" },
    { destination: "other-account" },
    { lamports: "0" },
    { lamports: "18446744073709551616" },
    { lamports: Number.MAX_SAFE_INTEGER + 1 },
    { instructionCount: 2 },
    { failed: true }
  ])("rejects an invalid or unrelated transfer: %o", (caseInput) => {
    expect(
      inspectGasTankFundingTransaction(transaction(caseInput), {
        payer,
        destination
      })
    ).toEqual({ status: "invalid" });
  });
});
