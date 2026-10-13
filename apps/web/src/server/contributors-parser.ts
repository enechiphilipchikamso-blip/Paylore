import ExcelJS from "exceljs";
import { isValidSolanaAddress } from "./security";

export type ContributorImportRow = {
  displayName: string;
  identityWalletAddress: string;
  effectivePayoutAddress: string;
  organizationLabel?: string;
  adminNote?: string;
};

export type ContributorImportResult = {
  rows: Array<{
    rowNumber: number;
    value: ContributorImportRow | null;
    errors: string[];
  }>;
  validCount: number;
  errorCount: number;
  duplicateWalletCount: number;
};

const MAX_IMPORT_BYTES = 5 * 1024 * 1024;
const MAX_IMPORT_ROWS = 500;
const MAX_IMPORT_COLUMNS = 20;
const COLUMN_ALIASES: Record<string, keyof ContributorImportRow> = {
  name: "displayName",
  displayname: "displayName",
  display_name: "displayName",
  identitywallet: "identityWalletAddress",
  identitywalletaddress: "identityWalletAddress",
  identity_wallet_address: "identityWalletAddress",
  payoutaddress: "effectivePayoutAddress",
  effectivepayoutaddress: "effectivePayoutAddress",
  effective_payout_address: "effectivePayoutAddress",
  organizationlabel: "organizationLabel",
  organization_label: "organizationLabel",
  adminnote: "adminNote",
  admin_note: "adminNote"
};

function normalizeHeader(value: string): keyof ContributorImportRow | null {
  return COLUMN_ALIASES[value.trim().toLowerCase().replace(/\s+/g, "")] ?? null;
}

function parseCsv(
  text: string,
  rowLimitMessage: string
): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        field += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        field += character;
      }
      continue;
    }

    if (character === '"' && field.length === 0) {
      quoted = true;
    } else if (character === ",") {
      row.push(field.trim());
      field = "";
    } else if (character === "\n" || character === "\r") {
      if (character === "\r" && text[index + 1] === "\n") {
        index += 1;
      }
      row.push(field.trim());
      field = "";
      if (row.some((cell) => cell.length > 0)) {
        rows.push(row);
        if (rows.length > MAX_IMPORT_ROWS + 1) {
          throw new Error(rowLimitMessage);
        }
      }
      row = [];
    } else {
      field += character;
    }
  }

  if (quoted) {
    throw new Error("The CSV file has an unterminated quoted field.");
  }
  row.push(field.trim());
  if (row.some((cell) => cell.length > 0)) {
    rows.push(row);
  }
  if (rows.length > MAX_IMPORT_ROWS + 1) {
    throw new Error(rowLimitMessage);
  }
  return rows;
}

function readCell(value: ExcelJS.CellValue): string {
  if (
    value === null ||
    value === undefined
  ) {
    return "";
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return String(value).trim();
  }
  if (
    typeof value === "object" &&
    "text" in value &&
    typeof value.text === "string"
  ) {
    return value.text.trim();
  }
  throw new Error("The XLSX file contains a non-text cell.");
}

async function parseXlsx(
  bytes: Uint8Array,
  rowLimitMessage: string
): Promise<string[][]> {
  const workbook = new ExcelJS.Workbook();
  const workbookBytes = new Uint8Array(bytes.byteLength);
  workbookBytes.set(bytes);
  await workbook.xlsx.load(workbookBytes.buffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) {
    throw new Error("The XLSX file does not contain a worksheet.");
  }
  if (sheet.rowCount > MAX_IMPORT_ROWS + 1) {
    throw new Error(rowLimitMessage);
  }
  const rows: string[][] = [];
  sheet.eachRow({ includeEmpty: false }, (row) => {
    if (row.cellCount > MAX_IMPORT_COLUMNS) {
      throw new Error("The file has too many columns.");
    }
    const values: string[] = [];
    row.eachCell({ includeEmpty: true }, (cell, column) => {
      values[column - 1] = readCell(cell.value);
    });
    rows.push(values);
  });
  return rows;
}

function rowsFromMatrix(
  matrix: string[][],
  existingWallets: ReadonlySet<string>
): ContributorImportResult {
  if (matrix.length === 0) {
    throw new Error("The file has no header row.");
  }
  if (matrix.length > MAX_IMPORT_ROWS + 1) {
    throw new Error("The file exceeds the 500 contributor row limit.");
  }
  if (matrix.some((row) => row.length > MAX_IMPORT_COLUMNS)) {
    throw new Error("The file has too many columns.");
  }

  const header = matrix[0].map(normalizeHeader);
  const required: Array<keyof ContributorImportRow> = [
    "displayName",
    "identityWalletAddress",
    "effectivePayoutAddress"
  ];
  const missing = required.filter((column) => !header.includes(column));
  if (missing.length > 0) {
    throw new Error("Required column is missing.");
  }

  const seenWallets = new Set(existingWallets);
  const resultRows: ContributorImportResult["rows"] = [];
  let duplicateWalletCount = 0;

  for (const [index, values] of matrix.slice(1).entries()) {
    const record: Partial<ContributorImportRow> = {};
    header.forEach((key, column) => {
      if (key) {
        record[key] = values[column]?.trim() ?? "";
      }
    });

    const value: ContributorImportRow = {
      displayName: record.displayName ?? "",
      identityWalletAddress: record.identityWalletAddress ?? "",
      effectivePayoutAddress: record.effectivePayoutAddress ?? "",
      ...(record.organizationLabel ? { organizationLabel: record.organizationLabel } : {}),
      ...(record.adminNote ? { adminNote: record.adminNote } : {})
    };
    const errors: string[] = [];

    if (!value.displayName) errors.push("Missing display name.");
    if (!value.identityWalletAddress) errors.push("Missing identity wallet.");
    if (!value.effectivePayoutAddress) errors.push("Missing payout address.");
    if (
      value.identityWalletAddress &&
      !isValidSolanaAddress(value.identityWalletAddress)
    ) {
      errors.push("Invalid Solana public key.");
    }
    if (
      value.effectivePayoutAddress &&
      !isValidSolanaAddress(value.effectivePayoutAddress)
    ) {
      errors.push("Invalid Solana public key.");
    }
    if (
      value.identityWalletAddress &&
      value.effectivePayoutAddress &&
      value.identityWalletAddress !== value.effectivePayoutAddress
    ) {
      errors.push("The effective payout address must match the identity wallet.");
    }
    if (
      value.identityWalletAddress &&
      seenWallets.has(value.identityWalletAddress)
    ) {
      errors.push(
        existingWallets.has(value.identityWalletAddress)
          ? "Duplicate wallet in this workspace."
          : "Duplicate row in this file."
      );
      duplicateWalletCount += 1;
    }
    if (value.identityWalletAddress) {
      seenWallets.add(value.identityWalletAddress);
    }

    resultRows.push({
      rowNumber: index + 2,
      value: errors.length === 0 ? value : null,
      errors
    });
  }

  return {
    rows: resultRows,
    validCount: resultRows.filter((row) => row.value !== null).length,
    errorCount: resultRows.filter((row) => row.errors.length > 0).length,
    duplicateWalletCount
  };
}

export async function readSpreadsheetMatrix(
  filename: string,
  bytes: Buffer,
  rowLabel: string
): Promise<string[][]> {
  if (bytes.length === 0 || bytes.length > MAX_IMPORT_BYTES) {
    throw new Error("The file must be between 1 byte and 5 MB.");
  }
  const rowLimitMessage = `The file exceeds the 500 ${rowLabel} row limit.`;
  const extension = filename.toLowerCase().split(".").pop();
  let matrix: string[][];
  if (extension === "csv") {
    matrix = parseCsv(
      bytes.toString("utf8").replace(/^\uFEFF/, ""),
      rowLimitMessage
    );
  } else if (extension === "xlsx") {
    matrix = await parseXlsx(bytes, rowLimitMessage);
  } else {
    throw new Error("Unsupported file format.");
  }
  if (matrix.some((row) => row.length > MAX_IMPORT_COLUMNS)) {
    throw new Error("The file has too many columns.");
  }
  return matrix;
}

export async function previewContributorFile(
  filename: string,
  bytes: Buffer,
  existingWallets: ReadonlySet<string>
): Promise<ContributorImportResult> {
  return rowsFromMatrix(
    await readSpreadsheetMatrix(filename, bytes, "contributor"),
    existingWallets
  );
}
