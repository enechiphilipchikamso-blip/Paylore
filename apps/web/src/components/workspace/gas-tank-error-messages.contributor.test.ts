import { describe, expect, it } from "vitest";
import { describeContributorSponsoredError } from "./gas-tank-error-messages";

describe("contributor-facing claim verification errors", () => {
  it("tells a contributor an unverified Claim account needs an administrator, not a retry", () => {
    const text = describeContributorSponsoredError("payroll_claim_creation_unverified", 409);
    expect(text).toContain("could not be verified against this allocation");
    expect(text).toContain("Ask a workspace administrator to resolve this.");
  });
});
