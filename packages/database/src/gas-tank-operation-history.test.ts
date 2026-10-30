import { describe, expect, it } from "vitest";
import {
  summarizeGasTankSponsorshipBudget,
  sumPreparedSponsoredRentReservations
} from "./gas-tank-operation-history";

describe("Gas Tank sponsorship fee accounting", () => {
  it("counts Reserve actual fees and only the unspent reservation", () => {
    const result = summarizeGasTankSponsorshipBudget({
      rows: [{
        status: "preparing",
        feeLamports: "200000",
        failureCode: null,
        operationData: {
          stage: "deposit_submitted",
          feeBudgetReserved: true,
          actualFeeLamports: "5000",
          feeReservationKeys: ["preapply:1", "deposit:1", "apply:1"]
        }
      }],
      reservedFeeLamports: "100000",
      since: new Date("2026-10-30T00:00:00.000Z")
    });
    expect(result).toMatchObject({
      feeLamports: 205000n,
      operationCount: 3,
      reservedFeesLamports: 200000n
    });
  });

  it("includes already-submitted legacy Reserve fees in the daily operation count", () => {
    const result = summarizeGasTankSponsorshipBudget({
      rows: [{
        status: "preparing",
        feeLamports: "200000",
        failureCode: null,
        operationData: {
          stage: "deposit_submitted",
          feeBudgetReserved: true,
          actualFeeLamports: "5000",
          feeReservationKeys: ["apply:1"],
          unreservedFeeOperationCount: 2
        }
      }],
      reservedFeeLamports: "100000",
      since: new Date("2026-10-30T00:00:00.000Z")
    });
    expect(result).toMatchObject({
      feeLamports: 205000n,
      operationCount: 3,
      reservedFeesLamports: 200000n
    });
  });

  it("does not charge the Gas Tank before the first confidential reservation", () => {
    const result = summarizeGasTankSponsorshipBudget({
      rows: [
        { status: "preparing", feeLamports: "0", failureCode: null, operationData: { stage: "wrap_pending" } },
        { status: "preparing", feeLamports: "0", failureCode: null, operationData: { stage: "wrap_verified" } }
      ],
      reservedFeeLamports: "100000",
      since: new Date("2026-10-30T00:00:00.000Z")
    });
    expect(result).toMatchObject({
      feeLamports: 0n,
      operationCount: 0,
      reservedFeesLamports: 0n
    });
  });
});

describe("Gas Tank sponsored account-rent reservations", () => {
  it("holds rent for preparing and prepared operations only", () => {
    expect(sumPreparedSponsoredRentReservations([
      { status: "preparing", operationData: { reservedRentLamports: "10000000" } },
      { status: "prepared", operationData: { reservedRentLamports: "250000" } },
      { status: "finalized", operationData: { reservedRentLamports: "500000" } },
      { status: "failed", operationData: { reservedRentLamports: "900000" } },
      { status: "cancelled", operationData: { reservedRentLamports: "800000" } }
    ])).toBe(10_250_000n);
  });

  it("fails closed when persisted rent reservations are malformed", () => {
    expect(() => sumPreparedSponsoredRentReservations([
      { status: "prepared", operationData: { reservedRentLamports: "-1" } }
    ])).toThrow("Persisted Gas Tank rent reservation is invalid.");
    expect(() => sumPreparedSponsoredRentReservations([
      { status: "preparing", operationData: { reservedRentLamports: 1000 } }
    ])).toThrow("Persisted Gas Tank rent reservation is invalid.");
  });

  it("ignores operations without an account-rent reservation", () => {
    expect(sumPreparedSponsoredRentReservations([
      { status: "preparing", operationData: { ownerAddress: "contributor-wallet" } },
      { status: "prepared", operationData: null }
    ])).toBe(0n);
  });
});
