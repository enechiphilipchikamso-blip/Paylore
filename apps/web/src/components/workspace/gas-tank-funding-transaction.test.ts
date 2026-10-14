import { describe, expect, it } from "vitest";
import {
  createGasTankFundingTransaction,
  solToLamports
} from "./gas-tank-funding-transaction";

describe("Gas Tank funding transaction", () => {
  it("converts SOL to lamports without floating-point rounding", () => {
    expect(solToLamports("1.000000001")).toBe("1000000001");
    expect(solToLamports("0.05")).toBe("50000000");
  });

  it.each(["", "0", "0.0000000001", "-1", "1e-3", "01"])(
    "rejects malformed or zero SOL input %s",
    (value) => {
      expect(() => solToLamports(value)).toThrow();
    }
  );

  it("builds a single wallet-signable Devnet transfer", () => {
    const transaction = createGasTankFundingTransaction({
      payer: "SysvarRent111111111111111111111111111111111",
      destination: "11111111111111111111111111111112",
      lamports: "50000000",
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 100
    });
    expect(transaction).toBeInstanceOf(Uint8Array);
    expect(transaction.length).toBeGreaterThan(20);
  });

  it("rejects amounts outside the System Program u64 range", () => {
    expect(() =>
      createGasTankFundingTransaction({
        payer: "SysvarRent111111111111111111111111111111111",
        destination: "11111111111111111111111111111112",
        lamports: "18446744073709551616",
        blockhash: "11111111111111111111111111111111",
        lastValidBlockHeight: 100
      })
    ).toThrow();
  });
});
