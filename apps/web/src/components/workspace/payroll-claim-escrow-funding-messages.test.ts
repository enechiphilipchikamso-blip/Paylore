import { describe, expect, it } from "vitest";
import { describeFundingPending } from "./payroll-claim-escrow-funding-messages";

describe("claim escrow funding pending messages", () => {
  it.each([
    ["claim_settlement_in_progress", "contributor claim"],
    ["funding_in_progress", "may still be running"],
    ["proof_setup_unconfirmed", "No transfer has been sent"],
    ["transfer_unconfirmed", "waiting for network finality"],
    ["transfer_outcome_unknown", "result could not be read"],
    ["balances_unverified", "balances could not be read"],
    ["proof_cleanup_pending", "temporary proof accounts"],
    ["lock_release_pending", "releasing the hold"],
    ["rollback_cleanup_pending", "no funds moved"],
    ["rollback_release_pending", "no funds moved"]
  ])("explains the %s stage", (stage, expected) => {
    expect(describeFundingPending(stage)).toContain(expected);
  });

  it("never says the escrow is funded when funding was rolled back", () => {
    expect(describeFundingPending("rollback_cleanup_pending")).not.toContain("escrow is funded");
    expect(describeFundingPending("rollback_release_pending")).not.toContain("escrow is funded");
  });

  it("appends the transaction signature when one exists", () => {
    expect(describeFundingPending("transfer_unconfirmed", "sig-1")).toMatch(/Transaction: sig-1$/);
  });

  it("falls back to a state-based message for an unknown or missing stage", () => {
    expect(describeFundingPending(undefined)).toContain("has not finished");
    expect(describeFundingPending("something_new")).toContain("Check funding");
  });
});
