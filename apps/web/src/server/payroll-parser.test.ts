import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import {
  previewPayrollFile,
  type PayrollContributor
} from "./payroll-parser";

const contributor: PayrollContributor = {
  id: "contributor-1",
  displayName: "Ada",
  identityWalletAddress: "11111111111111111111111111111111"
};
const contributors = new Map([
  [contributor.identityWalletAddress, contributor]
]);

function csv(rows: string[]) {
  return Buffer.from([
    "contributor,identity_wallet_address,amount_usdc",
    ...rows
  ].join("\n"));
}

describe("payroll import preview", () => {
  it("matches workspace contributors and converts decimal USDC exactly", async () => {
    const result = await previewPayrollFile(
      "payroll.csv",
      csv(["Ada,11111111111111111111111111111111,12.340056"]),
      contributors
    );

    expect(result).toMatchObject({
      validCount: 1,
      errorCount: 0,
      totalBaseUnits: "12340056",
      totalUsdc: "12.340056",
      rows: [{
        rowNumber: 2,
        value: {
          contributorId: "contributor-1",
          amountBaseUnits: "12340056",
          amountUsdc: "12.340056"
        },
        errors: []
      }]
    });
  });

  it("previews XLSX payroll using the same workspace and base-unit rules", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Payroll");
    sheet.addRow(["Contributor", "Identity Wallet", "USDC Amount"]);
    sheet.addRow([
      "Ada",
      contributor.identityWalletAddress,
      "0.000001"
    ]);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());
    const result = await previewPayrollFile(
      "payroll.xlsx",
      bytes,
      contributors
    );

    expect(result.validCount).toBe(1);
    expect(result.totalBaseUnits).toBe("1");
    expect(result.rows[0].value?.amountUsdc).toBe("0.000001");
  });

  it("rejects unknown wallets, duplicates, and mismatched names", async () => {
    const result = await previewPayrollFile(
      "payroll.csv",
      csv([
        "Grace,11111111111111111111111111111111,1",
        "Ada,11111111111111111111111111111111,2",
        "Unknown,11111111111111111111111111111112,3"
      ]),
      contributors
    );

    expect(result.errorCount).toBe(3);
    expect(result.rows[0].errors).toContain(
      "Contributor name does not match this workspace record."
    );
    expect(result.rows[1].errors).toContain(
      "Duplicate allocation in this file."
    );
    expect(result.rows[2].errors).toContain(
      "Wallet is not a contributor in this workspace."
    );
    expect(result.totalBaseUnits).toBe("0");
  });

  it.each(["0", "-1", "1.0000001", "1e3", "1,000", "18446744073710"])(
    "rejects invalid or out-of-range USDC amount %s",
    async (amount) => {
      const result = await previewPayrollFile(
        "payroll.csv",
        csv([`Ada,11111111111111111111111111111111,${amount}`]),
        contributors
      );

      expect(result.errorCount).toBe(1);
      expect(result.rows[0].value).toBeNull();
    }
  );

  it("rejects a combined payroll total beyond the token amount range", async () => {
    const secondContributor: PayrollContributor = {
      id: "contributor-2",
      displayName: "Grace",
      identityWalletAddress: "11111111111111111111111111111112"
    };
    const result = await previewPayrollFile(
      "payroll.csv",
      csv([
        "Ada,11111111111111111111111111111111,18446744073709.551615",
        "Grace,11111111111111111111111111111112,0.000001"
      ]),
      new Map([
        ...contributors,
        [secondContributor.identityWalletAddress, secondContributor]
      ])
    );

    expect(result.validCount).toBe(1);
    expect(result.errorCount).toBe(1);
    expect(result.totalBaseUnits).toBe("18446744073709551615");
    expect(result.rows[1].errors).toContain(
      "The payroll total exceeds the supported USDC amount."
    );
  });

  it("requires wallet and amount columns", async () => {
    await expect(
      previewPayrollFile(
        "payroll.csv",
        Buffer.from("name,amount\nAda,1"),
        contributors
      )
    ).rejects.toThrow("Required payroll column is missing.");
  });

  it("applies the shared spreadsheet size and row limits", async () => {
    const rows = Array.from(
      { length: 501 },
      () => "Ada,11111111111111111111111111111111,1"
    );
    await expect(
      previewPayrollFile("payroll.csv", csv(rows), contributors)
    ).rejects.toThrow("500 payroll row limit");
  });
});
