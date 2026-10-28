import { describe, expect, it } from "vitest";
import { getConfidentialAccountClosureBlocker } from "./confidential-account-closure-policy";

const eligible = {
  connectedWalletAddress: "contributor-wallet",
  ownerWalletAddress: "contributor-wallet",
  accountStatus: "ready",
  publicBalance: 0n,
  pendingBalance: 0n,
  availableBalance: 0n,
  hasOpenAllocations: false
};

describe("contributor-controlled confidential account closure policy", () => {
  it("permits closure only with owner authority and zero public, pending and available balances", () => {
    expect(getConfidentialAccountClosureBlocker(eligible)).toBeNull();
  });
  it("rejects a wallet that is not the recorded account owner", () => {
    expect(getConfidentialAccountClosureBlocker({ ...eligible, connectedWalletAddress: "other-wallet" }))
      .toBe("confidential_account_owner_mismatch");
  });
  it("rejects accounts that have not reached verified ready state", () => {
    expect(getConfidentialAccountClosureBlocker({ ...eligible, accountStatus: "setup_pending" }))
      .toBe("confidential_account_not_ready");
  });
  it("blocks closure when a payroll obligation remains open", () => {
    expect(getConfidentialAccountClosureBlocker({ ...eligible, hasOpenAllocations: true }))
      .toBe("outstanding_compensation_obligation");
  });
  it.each([{ publicBalance: 1n }, { pendingBalance: 1n }, { availableBalance: 1n }])(
    "blocks closure when a balance is non-zero: %o",
    (balances) => {
      expect(getConfidentialAccountClosureBlocker({ ...eligible, ...balances }))
        .toBe("confidential_account_balance_not_zero");
    }
  );
  it("fails closed when balance evidence is not available", () => {
    expect(getConfidentialAccountClosureBlocker({ ...eligible, availableBalance: null }))
      .toBe("confidential_balance_unavailable");
  });
});
