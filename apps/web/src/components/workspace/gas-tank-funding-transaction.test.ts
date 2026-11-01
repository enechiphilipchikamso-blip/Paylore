import { describe, expect, it } from "vitest";
import {
  createGasTankFundingTransaction,
  GAS_TANK_FUNDING_CHANGED,
  signedGasTankFunding,
  solToLamports
} from "./gas-tank-funding-transaction";

const fundingInput = {
  payer: "SysvarRent111111111111111111111111111111111",
  destination: "11111111111111111111111111111112",
  lamports: "50000000",
  blockhash: "11111111111111111111111111111111",
  lastValidBlockHeight: 100
};

// Wire layout: [signature count][64-byte signatures][message].
function withPayerSignature(transaction: Uint8Array): Uint8Array {
  const signed = Uint8Array.from(transaction);
  signed.fill(7, 1, 65);
  return signed;
}

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

  it("returns the payer signature only for the exact reviewed transfer", () => {
    const reviewed = createGasTankFundingTransaction(fundingInput);
    const result = signedGasTankFunding(
      reviewed,
      withPayerSignature(reviewed),
      fundingInput.payer
    );
    expect(result.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
    expect(atob(result.transactionBase64).length).toBe(reviewed.length);
  });

  it("refuses an unsigned or wallet-modified transfer", () => {
    const reviewed = createGasTankFundingTransaction(fundingInput);
    expect(() =>
      signedGasTankFunding(reviewed, reviewed, fundingInput.payer)
    ).toThrow("No funding was sent");
    const modified = withPayerSignature(
      createGasTankFundingTransaction({ ...fundingInput, lamports: "60000000" })
    );
    expect(() =>
      signedGasTankFunding(reviewed, modified, fundingInput.payer)
    ).toThrow(GAS_TANK_FUNDING_CHANGED);
  });
});
