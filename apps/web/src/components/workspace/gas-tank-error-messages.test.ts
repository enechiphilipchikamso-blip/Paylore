import { describe, expect, it } from "vitest";
import {
  describeAccountVerificationFailure,
  describeContributorSponsoredError,
  describeGasTankError
} from "./gas-tank-error-messages";

describe("Gas Tank error messages", () => {
  it("explains escrow failures instead of a generic Gas Tank fallback", () => {
    expect(describeGasTankError("payroll_claim_escrow_mint_not_approved")).toContain("auto-approve");
  });

  it("still surfaces unknown codes as a reference without claiming a Gas Tank rejection", () => {
    const text = describeGasTankError("some_new_code", 409);
    expect(text).toContain("some_new_code");
    expect(text).toContain("HTTP 409");
    expect(text).not.toContain("Gas Tank");
  });

  it("maps every payroll claim and recovery code the escrow, recovery and claim routes can return", () => {
    for (const code of [
      "escrow_funding_transaction_not_verified",
      "escrow_funding_claim_state_not_verified",
      "payroll_claim_escrow_funding_failed",
      "payroll_claim_escrow_account_not_ready",
      "confidential_settlement_failed",
      "confidential_transfer_submission_failed",
      "contributor_confidential_account_not_ready",
      "settlement_transaction_not_finalized",
      "payroll_recovery_submission_failed",
      "payroll_recovery_reconciliation_conflict",
      "recovery_escrow_available_balance_insufficient",
      "confidential_recovery_submission_failed",
      "workspace_busy"
    ]) {
      expect(describeGasTankError(code, 503), code).not.toContain("reference:");
    }
  });

  it("does not describe a failed escrow funding attempt as an on-chain failure", () => {
    expect(describeGasTankError("payroll_claim_escrow_funding_failed", 503)).not.toContain("on-chain");
  });

  it("treats empty bodies from platform timeouts as resumable", () => {
    expect(describeGasTankError(null, 504)).toContain("timed out");
  });

  it("does not blame the USDC mint for every account verification failure", () => {
    expect(describeAccountVerificationFailure("confidential_account_setup_failed", 503))
      .not.toContain("mint");
    expect(describeAccountVerificationFailure("confidential_mint_unavailable", 503))
      .toContain("mint");
    expect(describeAccountVerificationFailure(null, 409)).toContain("not been verified as finalized");
  });

  it("tells contributors to ask an administrator instead of funding the Gas Tank", () => {
    expect(describeContributorSponsoredError("gas_tank_insufficient_balance")).toContain("administrator");
  });
});
