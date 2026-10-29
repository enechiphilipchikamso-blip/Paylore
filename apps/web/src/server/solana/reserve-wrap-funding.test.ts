import { describe, expect, it } from "vitest";
import { assertExactReserveWrapTokenBalanceDeltas, ReserveWrapFundingError } from "./reserve-wrap-funding";

describe("finalized ordinary-USDC Reserve wrap reconciliation", () => {
  it("accepts an exact source debit, escrow credit and Reserve credit", () => {
    expect(() => assertExactReserveWrapTokenBalanceDeltas({
      amountBaseUnits: 12500000n, sourceDebitBaseUnits: 12500000n,
      escrowCreditBaseUnits: 12500000n, destinationCreditBaseUnits: 12500000n
    })).not.toThrow();
  });

  it.each([
    { sourceDebitBaseUnits: 12499999n, escrowCreditBaseUnits: 12500000n, destinationCreditBaseUnits: 12500000n },
    { sourceDebitBaseUnits: 12500000n, escrowCreditBaseUnits: 12499999n, destinationCreditBaseUnits: 12500000n },
    { sourceDebitBaseUnits: 12500000n, escrowCreditBaseUnits: 12500000n, destinationCreditBaseUnits: 12499999n }
  ])("rejects a one-sided balance mismatch", balances => {
    expect(() => assertExactReserveWrapTokenBalanceDeltas({
      amountBaseUnits: 12500000n, ...balances
    })).toThrowError(ReserveWrapFundingError);
  });

  it("rejects zero and values above u64", () => {
    for (const amountBaseUnits of [0n, -1n, 1n << 64n]) {
      expect(() => assertExactReserveWrapTokenBalanceDeltas({
        amountBaseUnits, sourceDebitBaseUnits: amountBaseUnits,
        escrowCreditBaseUnits: amountBaseUnits, destinationCreditBaseUnits: amountBaseUnits
      })).toThrowError(ReserveWrapFundingError);
    }
  });
});
