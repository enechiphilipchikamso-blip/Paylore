import { describe, expect, it } from "vitest";
import { assertConfidentialWithdrawalAvailable } from "./confidential-balance-policy";

describe("confidential withdrawal readiness", () => {
  it("allows a positive withdrawal only from available confidential funds", () => {
    expect(() => assertConfidentialWithdrawalAvailable({
      amountBaseUnits: 100n, availableBalance: 500n, pendingBalance: 0n
    })).not.toThrow();
  });

  it("requires pending credits to be applied before withdrawal", () => {
    expect(() => assertConfidentialWithdrawalAvailable({
      amountBaseUnits: 100n, availableBalance: 500n, pendingBalance: 1n
    })).toThrow("Apply pending confidential credits before withdrawing");
  });

  it("rejects withdrawals larger than available balance", () => {
    expect(() => assertConfidentialWithdrawalAvailable({
      amountBaseUnits: 501n, availableBalance: 500n, pendingBalance: 0n
    })).toThrow("greater than the available confidential balance");
  });

  it("rejects zero amounts and invalid balance evidence", () => {
    expect(() => assertConfidentialWithdrawalAvailable({
      amountBaseUnits: 0n, availableBalance: 500n, pendingBalance: 0n
    })).toThrow("positive USDC amount");
    expect(() => assertConfidentialWithdrawalAvailable({
      amountBaseUnits: 1n, availableBalance: -1n, pendingBalance: 0n
    })).toThrow("could not be verified");
  });
});
