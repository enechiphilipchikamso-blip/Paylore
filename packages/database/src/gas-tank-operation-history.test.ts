import { describe, expect, it } from "vitest";
import { sumPreparedSponsoredRentReservations } from "./gas-tank-operation-history";

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
