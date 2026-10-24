import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";
import { previewContributorFile } from "./contributors-parser";

const identityWallet = "11111111111111111111111111111111";

function csv(rows: string[]) {
  return Buffer.from([
    "display_name,identity_wallet_address,effective_payout_address",
    ...rows
  ].join("\n"));
}

describe("contributor import preview", () => {
  it("validates CSV rows and reports their source row numbers", async () => {
    const result = await previewContributorFile(
      "contributors.csv",
      csv([`Ada,${identityWallet},${identityWallet}`]),
      new Set()
    );

    expect(result.validCount).toBe(1);
    expect(result.errorCount).toBe(0);
    expect(result.rows[0]).toMatchObject({
      rowNumber: 2,
      value: {
        displayName: "Ada",
        identityWalletAddress: identityWallet,
        effectivePayoutAddress: identityWallet
      },
      errors: []
    });
  });

  it("rejects duplicate wallets in the file and existing workspace", async () => {
    const inFile = await previewContributorFile(
      "contributors.csv",
      csv([
        `Ada,${identityWallet},${identityWallet}`,
        `Grace,${identityWallet},${identityWallet}`
      ]),
      new Set()
    );
    const existing = await previewContributorFile(
      "contributors.csv",
      csv([`Ada,${identityWallet},${identityWallet}`]),
      new Set([identityWallet])
    );

    expect(inFile.duplicateWalletCount).toBe(1);
    expect(inFile.rows[1].errors).toContain("Duplicate row in this file.");
    expect(existing.rows[0].errors).toContain("Duplicate wallet in this workspace.");
  });

  it("rejects missing required columns and malformed quoted CSV", async () => {
    await expect(
      previewContributorFile(
        "contributors.csv",
        Buffer.from("name,identity_wallet_address\nAda,11111111111111111111111111111111"),
        new Set()
      )
    ).rejects.toThrow("Required column is missing.");

    await expect(
      previewContributorFile(
        "contributors.csv",
        Buffer.from('"display_name,identity_wallet_address,effective_payout_address'),
        new Set()
      )
    ).rejects.toThrow("unterminated quoted field");
  });

  it("reads XLSX workbooks and preserves workspace-safe role defaults", async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet("Contributors");
    sheet.addRow(["display_name", "identity_wallet_address", "effective_payout_address", "role"]);
    sheet.addRow(["Ada", identityWallet, identityWallet, "Finance/Auditor"]);
    const bytes = Buffer.from(await workbook.xlsx.writeBuffer());

    const result = await previewContributorFile("contributors.xlsx", bytes, new Set());
    expect(result.validCount).toBe(1);
    expect(result.rows[0]?.value?.role).toBe("finance_auditor");
  });

  it("defaults missing roles to Contributor and blocks elevated or unknown roles", async () => {
    const defaultRole = await previewContributorFile(
      "contributors.csv",
      csv([`Grace,${identityWallet},${identityWallet}`]),
      new Set()
    );
    expect(defaultRole.rows[0]?.value?.role).toBe("contributor");

    const elevated = await previewContributorFile(
      "contributors.csv",
      Buffer.from([
        "display_name,identity_wallet_address,effective_payout_address,role",
        `Eve,${identityWallet},${identityWallet},organization_admin`
      ].join("\n")),
      new Set()
    );
    expect(elevated.validCount).toBe(0);
    expect(elevated.rows[0]?.errors).toContain("Role must be Contributor or Finance/Auditor.");
  });

  it("rejects invalid quote placement after a closed CSV field", async () => {
    await expect(
      previewContributorFile(
        "contributors.csv",
        Buffer.from('display_name,identity_wallet_address,effective_payout_address\n"Ada"x,11111111111111111111111111111111,11111111111111111111111111111111'),
        new Set()
      )
    ).rejects.toThrow("invalid quoted field");
  });

  it("enforces the import row limit", async () => {
    const rows = Array.from(
      { length: 501 },
      (_, index) => `Contributor ${index},${identityWallet},${identityWallet}`
    );

    await expect(
      previewContributorFile("contributors.csv", csv(rows), new Set())
    ).rejects.toThrow("500 contributor row limit");
  });
});
