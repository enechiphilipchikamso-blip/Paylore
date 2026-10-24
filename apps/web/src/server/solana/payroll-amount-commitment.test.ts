import { describe, expect, it } from "vitest";
import { derivePayrollAmountCommitmentMaterial } from "./payroll-amount-commitment";

const secretHex = "42".repeat(32);
const claimId = "11".repeat(32);
const allocationCommitment = "22".repeat(32);

describe("confidential allocation amount commitments", () => {
  it("reproduces the same hiding commitment and opening for the same allocation", () => {
    const input = { amountBaseUnits: "1250000", claimId, allocationCommitment, secretHex };
    const first = derivePayrollAmountCommitmentMaterial(input);
    const second = derivePayrollAmountCommitmentMaterial(input);
    expect(first.amountCommitment).toBe(second.amountCommitment);
    expect(Buffer.from(first.opening)).toEqual(Buffer.from(second.opening));
    expect(first.amountCommitment).toMatch(/^[0-9a-f]{64}$/);
  });

  it("binds the commitment to both the approved amount and allocation identity", () => {
    const baseline = derivePayrollAmountCommitmentMaterial({
      amountBaseUnits: "1250000", claimId, allocationCommitment, secretHex
    });
    expect(derivePayrollAmountCommitmentMaterial({
      amountBaseUnits: "1250001", claimId, allocationCommitment, secretHex
    }).amountCommitment).not.toBe(baseline.amountCommitment);
    expect(derivePayrollAmountCommitmentMaterial({
      amountBaseUnits: "1250000", claimId: "33".repeat(32), allocationCommitment, secretHex
    }).amountCommitment).not.toBe(baseline.amountCommitment);
    expect(derivePayrollAmountCommitmentMaterial({
      amountBaseUnits: "1250000", claimId, allocationCommitment: "44".repeat(32), secretHex
    }).amountCommitment).not.toBe(baseline.amountCommitment);
  });

  it.each(["0", "-1", "01", "1.5", "18446744073709551616"])(
    "rejects invalid base-unit amount %s",
    (amountBaseUnits) => {
      expect(() => derivePayrollAmountCommitmentMaterial({
        amountBaseUnits, claimId, allocationCommitment, secretHex
      })).toThrow();
    }
  );

  it("rejects malformed secret and allocation identifiers", () => {
    expect(() => derivePayrollAmountCommitmentMaterial({
      amountBaseUnits: "1", claimId, allocationCommitment, secretHex: "not-secret"
    })).toThrow("32-byte hexadecimal key");
    expect(() => derivePayrollAmountCommitmentMaterial({
      amountBaseUnits: "1", claimId: "bad", allocationCommitment, secretHex
    })).toThrow("32-byte hexadecimal values");
  });
});
