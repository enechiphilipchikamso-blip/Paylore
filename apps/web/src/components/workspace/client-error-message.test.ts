import { describe, expect, it } from "vitest";
import { describeClientError } from "./client-error-message";

describe("client error messages", () => {
  it("adds operation context and preserves a specific provider reason", () => {
    expect(describeClientError(
      new Error("Blockhash not found"),
      "Payroll claim",
      "Try again."
    )).toBe("Payroll claim failed: Blockhash not found");
  });

  it("does not leave a generic wallet error as the entire user-facing message", () => {
    expect(describeClientError(
      new Error("Internal error"),
      "Payroll claim",
      "Try again."
    )).toContain("the provider returned only \"Internal error\".");
  });

  it("uses a nested provider cause when the wrapper only says internal error", () => {
    const error = new Error("Internal error", { cause: new Error("RPC request timed out") });
    expect(describeClientError(error, "Payroll claim", "Try again."))
      .toBe("Payroll claim failed: RPC request timed out");
  });
});
