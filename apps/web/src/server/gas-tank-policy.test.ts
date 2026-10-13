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
          { pubkey: input.signer ?? payer, signer: true }
        ],
        instructions: Array.from(
          { length: input.instructionCount ?? 1 },
          () => instruction
        )
      }
    }
  };
}

describe("Gas Tank manual funding transaction policy", () => {
  it("accepts only a finalized exact system transfer from the session wallet", () => {
    expect(
      inspectGasTankFundingTransaction(transaction({}), {
        payer,
        destination
      })
    ).toEqual({ status: "confirmed", lamports: "50000000" });
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
