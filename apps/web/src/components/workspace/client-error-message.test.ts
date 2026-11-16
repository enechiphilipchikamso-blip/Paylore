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

  it.each([
    "Internal error.",
    "Internal JSON-RPC error.",
    "Unexpected error",
    "An unexpected error occurred."
  ])("recognises the generic provider text %j", (text) => {
    expect(describeClientError(new Error(text), "Payroll claim", "Try again."))
      .toContain(`the provider returned only "${text}".`);
  });

  it("reads the message of a non-Error object thrown by a wallet", () => {
    expect(describeClientError({ code: -32603, message: "Internal error" }, "Payroll claim", "Try again."))
      .toContain("the provider returned only \"Internal error\".");
    expect(describeClientError({ message: "User rejected the request." }, "Payroll claim", "Try again."))
      .toBe("Payroll claim failed: User rejected the request.");
  });

  it("falls back when nothing readable was thrown", () => {
    expect(describeClientError(undefined, "Payroll claim", "Try again."))
      .toBe("Payroll claim failed: Try again.");
  });

  it("uses a nested provider cause when the wrapper only says internal error", () => {
    const error = new Error("Internal error", { cause: new Error("RPC request timed out") });
    expect(describeClientError(error, "Payroll claim", "Try again."))
      .toBe("Payroll claim failed: RPC request timed out");
  });
});
