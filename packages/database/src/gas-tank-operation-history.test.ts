import { describe, expect, it } from "vitest";
import {
  summarizeGasTankSponsorshipBudget,
  summarizeGasTankSponsorshipWindowTiming,
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

describe("Gas Tank sponsorship window timing", () => {
  const HOUR = 60 * 60 * 1000;
  const WINDOW = 24 * HOUR;
  const at = (hours: number) => new Date(Date.UTC(2026, 0, 1) + hours * HOUR);
  const record = (createdHours: number, updatedHours = createdHours) => ({
    createdAt: at(createdHours),
    updatedAt: at(updatedHours)
  });

  it("reports nothing counted for an empty window", () => {
    expect(summarizeGasTankSponsorshipWindowTiming({ rows: [], recordLimit: 3, windowMs: WINDOW }))
      .toEqual({ recordCount: 0, limitReached: false, nextReleaseAt: null, resumesAt: null, clearsAt: null });
  });

  it("measures each record from its latest update, in any input order", () => {
    const timing = summarizeGasTankSponsorshipWindowTiming({
      rows: [record(5), record(1, 9), record(3)],
      recordLimit: 10,
      windowMs: WINDOW
    });
    expect(timing.recordCount).toBe(3);
    expect(timing.limitReached).toBe(false);
    expect(timing.resumesAt).toBe(null);
    expect(timing.nextReleaseAt).toBe(at(3).getTime() + WINDOW);
    expect(timing.clearsAt).toBe(at(9).getTime() + WINDOW);
  });

  it("does not report the limit as reached at exactly the limit", () => {
    const timing = summarizeGasTankSponsorshipWindowTiming({
      rows: [record(1), record(2), record(3)],
      recordLimit: 3,
      windowMs: WINDOW
    });
    expect(timing.limitReached).toBe(false);
    expect(timing.resumesAt).toBe(null);
  });

  it("resumes when the count is back to the limit, not when only the oldest record leaves", () => {
    // 5 records, limit 3: two must leave before the count is 3 again.
    const timing = summarizeGasTankSponsorshipWindowTiming({
      rows: [record(40), record(10), record(30), record(20), record(50)],
      recordLimit: 3,
      windowMs: WINDOW
    });
    expect(timing.recordCount).toBe(5);
    expect(timing.limitReached).toBe(true);
    expect(timing.nextReleaseAt).toBe(at(10).getTime() + WINDOW);
    expect(timing.resumesAt).toBe(at(20).getTime() + WINDOW);
    expect(timing.clearsAt).toBe(at(50).getTime() + WINDOW);
  });

  it("resumes at the oldest record when exactly one record is over the limit", () => {
    const timing = summarizeGasTankSponsorshipWindowTiming({
      rows: [record(4), record(2), record(3), record(1)],
      recordLimit: 3,
      windowMs: WINDOW
    });
    expect(timing.limitReached).toBe(true);
    expect(timing.resumesAt).toBe(at(1).getTime() + WINDOW);
  });
});
