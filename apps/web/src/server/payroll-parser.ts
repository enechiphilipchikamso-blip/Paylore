import { readSpreadsheetMatrix } from "./contributors-parser";

const USDC_BASE_UNITS = 1_000_000n;
const MAX_TOKEN_AMOUNT = (1n << 64n) - 1n;

export type PayrollContributor = {
  id: string;
  displayName: string;
  identityWalletAddress: string;
};

export type PayrollImportRow = {
  contributorId: string;
  displayName: string;
  identityWalletAddress: string;
  amountBaseUnits: string;
  amountUsdc: string;
};

export type PayrollImportResult = {
  rows: Array<{
    rowNumber: number;
    value: PayrollImportRow | null;
    errors: string[];
  }>;
  validCount: number;
  errorCount: number;
  totalBaseUnits: string;
  totalUsdc: string;
};

const COLUMN_ALIASES = {
  contributor: "displayName",
  contributorname: "displayName",
  displayname: "displayName",
  name: "displayName",
  identitywallet: "identityWalletAddress",
  identitywalletaddress: "identityWalletAddress",
  identity_wallet_address: "identityWalletAddress",
  wallet: "identityWalletAddress",
  walletaddress: "identityWalletAddress",
  amount: "amountUsdc",
  amountusdc: "amountUsdc",
  amount_usdc: "amountUsdc",
  usdc: "amountUsdc",
  usdcamount: "amountUsdc",
  usdc_amount: "amountUsdc"
} as const;

type PayrollColumn = (typeof COLUMN_ALIASES)[keyof typeof COLUMN_ALIASES];

function normalizeHeader(value: string): PayrollColumn | null {
  const header = value.trim().toLowerCase().replace(/\s+/g, "");
  return COLUMN_ALIASES[header as keyof typeof COLUMN_ALIASES] ?? null;
}

function parseUsdcAmount(value: string): bigint | null {
  const normalized = value.trim();
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(normalized)) {
    return null;
  }

  const [whole, fraction = ""] = normalized.split(".");
  const baseUnits =
    BigInt(whole) * USDC_BASE_UNITS +
    BigInt(fraction.padEnd(6, "0") || "0");
  if (baseUnits <= 0n || baseUnits > MAX_TOKEN_AMOUNT) {
    return null;
  }
  return baseUnits;
}

function formatUsdc(baseUnits: bigint): string {
  const whole = baseUnits / USDC_BASE_UNITS;
  const fraction = (baseUnits % USDC_BASE_UNITS)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export async function previewPayrollFile(
  filename: string,
  bytes: Buffer,
  workspaceContributors: ReadonlyMap<string, PayrollContributor>
): Promise<PayrollImportResult> {
  const matrix = await readSpreadsheetMatrix(filename, bytes, "payroll");
  if (matrix.length === 0) {
    throw new Error("The file has no header row.");
  }

  const headers = matrix[0].map(normalizeHeader);
  if (
    !headers.includes("identityWalletAddress") ||
    !headers.includes("amountUsdc")
  ) {
    throw new Error("Required payroll column is missing.");
  }
  if (headers.some((header) => header === null)) {
    throw new Error("The file contains an unsupported payroll column.");
  }

  const seenWallets = new Set<string>();
  let totalBaseUnits = 0n;
  const rows: PayrollImportResult["rows"] = matrix
    .slice(1)
    .map((values, index) => {
      const record: Partial<Record<PayrollColumn, string>> = {};
      headers.forEach((header, column) => {
        if (header) record[header] = values[column]?.trim() ?? "";
      });

      const identityWalletAddress =
        record.identityWalletAddress ?? "";
      const amountText = record.amountUsdc ?? "";
      const contributor =
        workspaceContributors.get(identityWalletAddress);
      const errors: string[] = [];

      if (values.length !== headers.length) {
        errors.push("Row values do not match the payroll header.");
      }
      if (!identityWalletAddress) {
        errors.push("Missing identity wallet.");
      } else if (!contributor) {
        errors.push("Wallet is not a contributor in this workspace.");
      }
      if (
        contributor &&
        record.displayName &&
        record.displayName !== contributor.displayName
      ) {
        errors.push("Contributor name does not match this workspace record.");
      }
      if (identityWalletAddress && seenWallets.has(identityWalletAddress)) {
        errors.push("Duplicate allocation in this file.");
      }
      if (identityWalletAddress) seenWallets.add(identityWalletAddress);

      const amountBaseUnits = parseUsdcAmount(amountText);
      if (amountBaseUnits === null) {
        errors.push(
          "Enter a positive USDC amount with no more than six decimal places."
        );
      } else if (
        totalBaseUnits + amountBaseUnits >
        MAX_TOKEN_AMOUNT
      ) {
        errors.push("The payroll total exceeds the supported USDC amount.");
      }

      if (contributor && amountBaseUnits !== null && errors.length === 0) {
        totalBaseUnits += amountBaseUnits;
        return {
          rowNumber: index + 2,
          errors,
          value: {
            contributorId: contributor.id,
            displayName: contributor.displayName,
            identityWalletAddress: contributor.identityWalletAddress,
            amountBaseUnits: amountBaseUnits.toString(),
            amountUsdc: formatUsdc(amountBaseUnits)
          }
        };
      }

      return {
        rowNumber: index + 2,
        value: null,
        errors
      };
    });

  return {
    rows,
    validCount: rows.filter((row) => row.value !== null).length,
    errorCount: rows.filter((row) => row.errors.length > 0).length,
    totalBaseUnits: totalBaseUnits.toString(),
    totalUsdc: formatUsdc(totalBaseUnits)
  };
}
