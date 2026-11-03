import { describe, expect, it } from "vitest";
import { describeContributorSponsoredError, describeGasTankError } from "./gas-tank-error-messages";

describe("Gas Tank error messages", () => {
  it("explains escrow failures instead of a generic Gas Tank fallback", () => {
    expect(describeGasTankError("payroll_claim_escrow_mint_not_approved")).toContain("auto-approve");
  });

  it("still surfaces unknown codes as a reference", () => {
    expect(describeGasTankError("some_new_code", 409)).toContain("some_new_code");
  });

  it("treats empty bodies from platform timeouts as resumable", () => {
    expect(describeGasTankError(null, 504)).toContain("timed out");
  });

  it("tells contributors to ask an administrator instead of funding the Gas Tank", () => {
    expect(describeContributorSponsoredError("gas_tank_insufficient_balance")).toContain("administrator");
  });
});
