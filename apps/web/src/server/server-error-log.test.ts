import { afterEach, describe, expect, it, vi } from "vitest";
import {
  describeFailureForLog,
  logServerFailure,
  logServerRejection
} from "./server-error-log";

describe("server failure logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the error class, code, message and cause", () => {
    class CodedError extends Error {
      constructor(readonly code: string, message: string, options?: ErrorOptions) {
        super(message, options);
        this.name = "CodedError";
      }
    }
    const details = describeFailureForLog(
      new CodedError("gas_tank_insufficient_balance", "balance check failed", {
        cause: new Error("RPC request timed out")
      })
    );
    expect(details).toEqual({
      errorName: "CodedError",
      errorCode: "gas_tank_insufficient_balance",
      errorMessage: "balance check failed",
      causeMessage: "RPC request timed out"
    });
  });

  it("removes provider URLs and credential-looking values", () => {
    const details = describeFailureForLog(
      new Error(
        "fetch failed for https://rpc.example.test/v1?api-key=abc123 with Authorization: Bearer s3cr3t and token=xyz"
      )
    );
    expect(details.errorMessage).not.toContain("abc123");
    expect(details.errorMessage).not.toContain("s3cr3t");
    expect(details.errorMessage).not.toContain("xyz");
    expect(details.errorMessage).not.toContain("rpc.example.test");
    expect(details.errorMessage).toContain("[url]");
  });

  it("bounds very long messages", () => {
    const details = describeFailureForLog(new Error("x".repeat(5_000)));
    expect(details.errorMessage.length).toBeLessThanOrEqual(300);
  });

  it("describes non-Error values without echoing objects", () => {
    expect(describeFailureForLog({ secret: "value" })).toEqual({
      errorName: "object",
      errorMessage: "A non-Error value was thrown."
    });
    expect(describeFailureForLog("plain text").errorMessage).toBe("plain text");
  });

  it("records a typed rejection with its code and status", () => {
    const spy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    logServerRejection("payroll_claim_escrow_funding_rejected", "gas_tank_insufficient_balance", 409, {
      allocationId: "a-1"
    });
    expect(JSON.parse(String(spy.mock.calls[0]?.[0]))).toEqual({
      event: "payroll_claim_escrow_funding_rejected",
      errorCode: "gas_tank_insufficient_balance",
      status: 409,
      allocationId: "a-1"
    });
  });

  it("writes one JSON line containing the event and context", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logServerFailure("payroll_claim_escrow_funding_failed", new Error("boom"), {
      workspaceId: "w-1"
    });
    expect(spy).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(spy.mock.calls[0]?.[0]));
    expect(line).toMatchObject({
      event: "payroll_claim_escrow_funding_failed",
      workspaceId: "w-1",
      errorName: "Error",
      errorMessage: "boom"
    });
  });
});
