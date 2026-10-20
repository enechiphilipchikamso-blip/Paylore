import { describe, expect, it } from "vitest";
import { transactionInvokesProgram } from "./transaction-program-invocation";

const payrollProgram = "payroll-program";

describe("canonical program invocation verification", () => {
  it("accepts a parsed top-level invocation of the configured program", () => {
    expect(
      transactionInvokesProgram(
        {
          transaction: {
            message: {
              accountKeys: [{ pubkey: payrollProgram }],
              instructions: [{ programId: payrollProgram }]
            }
          }
        },
        payrollProgram
      )
    ).toBe(true);
  });

  it("resolves a compiled program index against transaction account keys", () => {
    expect(
      transactionInvokesProgram(
        {
          transaction: {
            message: {
              accountKeys: [
                { pubkey: "system-program" },
                { pubkey: payrollProgram }
              ],
              instructions: [{ programIdIndex: 1 }]
            }
          }
        },
        payrollProgram
      )
    ).toBe(true);
  });

  it("recognizes a canonical program invoked by a CPI", () => {
    expect(
      transactionInvokesProgram(
        {
          transaction: {
            message: {
              accountKeys: [{ pubkey: payrollProgram }],
              instructions: [{ programId: "associated-token-program" }]
            }
          },
          meta: {
            innerInstructions: [
              { index: 0, instructions: [{ programId: payrollProgram }] }
            ]
          }
        },
        payrollProgram
      )
    ).toBe(true);
  });

  it.each([
    { transaction: { message: { instructions: [{ accounts: [] }] } } },
    {
      transaction: {
        message: {
          accountKeys: [{ pubkey: "other-program" }],
          instructions: [{ programIdIndex: 3 }]
        }
      }
    },
    {
      transaction: {
        message: {
          accountKeys: [{ pubkey: "other-program" }],
          instructions: [{ programId: "other-program" }]
        }
      }
    },
    null
  ])("rejects malformed or unrelated transaction evidence: %o", (value) => {
    expect(transactionInvokesProgram(value, payrollProgram)).toBe(false);
  });

  it("fails closed when the canonical program ID is not configured", () => {
    expect(
      transactionInvokesProgram(
        {
          transaction: {
            message: {
              accountKeys: [{ pubkey: payrollProgram }],
              instructions: [{ programId: payrollProgram }]
            }
          }
        },
        ""
      )
    ).toBe(false);
  });
});
