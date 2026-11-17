import { describe, expect, it } from "vitest";
import {
  describeAmountIssue,
  describeContributorAllocation,
  isClaimableAllocation,
  shortReference,
  summarizeContributorAllocations
} from "./contributor-allocation-view";

const created = { claimAddress: "claim-pda", transactionSignature: "creation-signature" };

describe("contributor allocation presentation", () => {
  it("treats only unclaimed and settlement-pending allocations as claimable", () => {
    expect(isClaimableAllocation("unclaimed")).toBe(true);
    expect(isClaimableAllocation("settlement_pending")).toBe(true);
    for (const status of ["claimed", "recovered", "cancelled", "draft", "recovery_pending"]) {
      expect(isClaimableAllocation(status)).toBe(false);
    }
  });

  it("labels every status distinctly instead of calling everything unclaimed", () => {
    const view = (status: string, extra = created) =>
      describeContributorAllocation({ status, amountBaseUnits: "1", ...extra });
    expect(view("unclaimed")).toMatchObject({ label: "Ready to claim", tone: "partial", detail: "Unclaimed — no transfer recorded" });
    expect(view("settlement_pending").label).toBe("Settlement pending");
    expect(view("claimed")).toMatchObject({ label: "Settled", tone: "success" });
    expect(view("recovered").label).toBe("Recovered");
    expect(view("recovery_pending").label).toBe("Recovery pending");
    expect(view("cancelled")).toMatchObject({ label: "Cancelled", tone: "error" });
    expect(view("draft").label).toBe("Awaiting commitment");
    expect(view("some_new_state").label).toBe("some new state");
  });

  it("does not call an allocation ready to claim before its Claim account is recorded", () => {
    expect(describeContributorAllocation({
      status: "unclaimed", amountBaseUnits: "1", claimAddress: null, transactionSignature: null
    })).toMatchObject({ label: "Awaiting commitment", tone: "neutral" });
  });

  it("totals claimable, settled and recovered amounts without mixing them", () => {
    expect(summarizeContributorAllocations([
      { status: "unclaimed", amountBaseUnits: "1250000" },
      { status: "settlement_pending", amountBaseUnits: "2000000" },
      { status: "claimed", amountBaseUnits: "3000000" },
      { status: "recovered", amountBaseUnits: "4000000" },
      { status: "cancelled", amountBaseUnits: "5000000" },
      { status: "unclaimed", amountBaseUnits: "not-a-number" }
    ])).toEqual({
      claimableCount: 2, claimableBaseUnits: 3_250_000n,
      settledCount: 1, settledBaseUnits: 3_000_000n,
      recoveredCount: 1, recoveredBaseUnits: 4_000_000n
    });
  });

  it("shortens long references and leaves short ones intact", () => {
    expect(shortReference("short")).toBe("short");
    expect(shortReference("A".repeat(10) + "B".repeat(30))).toBe("AAAAAAAA…BBBBBBBB");
  });

  it("explains an amount that cannot be submitted before any wallet prompt", () => {
    const base = { maxBaseUnits: 1_500_000n, maxLabel: "available balance (1.5 wrapped USDC)" };
    expect(describeAmountIssue({ ...base, rawAmount: "" })).toBeNull();
    expect(describeAmountIssue({ ...base, rawAmount: "1.5" })).toBeNull();
    expect(describeAmountIssue({ ...base, rawAmount: "0" })).toMatch(/greater than zero/);
    expect(describeAmountIssue({ ...base, rawAmount: "-1" })).toMatch(/six decimal places/);
    expect(describeAmountIssue({ ...base, rawAmount: "1.1234567" })).toMatch(/six decimal places/);
    expect(describeAmountIssue({ ...base, rawAmount: "1.500001" })).toMatch(/more than your available balance/);
  });
});
