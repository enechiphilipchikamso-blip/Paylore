export const LEDGER_CATEGORIES = [
  "billing",
  "payroll",
  "recovery",
  "gas_operations",
  "cash_out"
] as const;

export const LEDGER_CATEGORY_LABELS: Record<
  (typeof LEDGER_CATEGORIES)[number],
  string
> = {
  billing: "Workspace & Billing",
  payroll: "Payroll & Claims",
  recovery: "Recovery & Offboarding",
  gas_operations: "Gas Tank & Network Operations",
  cash_out: "Cash Out & Withdrawals"
};

export const LEDGER_STATUSES = [
  "prepared",
  "submitted",
  "confirming",
  "finalized",
  "failed",
  "reversed",
  "pending"
] as const;

export type LedgerCursor = {
  createdAt: Date;
  id: string;
};

export function parseLedgerDate(
  value: string | null | undefined,
  exclusiveEnd = false
): Date | undefined | null {
  if (value === null || value === undefined || value === "") {
    return undefined;
  }
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== value
  ) {
    return null;
  }
  if (exclusiveEnd) date.setUTCDate(date.getUTCDate() + 1);
  return date;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function encodeLedgerCursor(cursor: LedgerCursor): string {
  return Buffer.from(
    `${cursor.createdAt.toISOString()}\n${cursor.id}`,
    "utf8"
  ).toString("base64url");
}

export function decodeLedgerCursor(value: string): LedgerCursor | null {
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(value)) return null;
  try {
    const decoded = Buffer.from(value, "base64url").toString("utf8");
    const [dateText, id, extra] = decoded.split("\n");
    if (
      extra !== undefined ||
      !dateText ||
      !id ||
      !UUID_PATTERN.test(id)
    ) {
      return null;
    }
    const timestamp = Date.parse(dateText);
    if (!Number.isFinite(timestamp)) return null;
    const createdAt = new Date(timestamp);
    if (createdAt.toISOString() !== dateText) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export function csvCell(value: string): string {
  const protectedValue = /^[\t\r\n ]*[=+\-@]/.test(value)
    ? `'${value}`
    : value;
  return `"${protectedValue.replace(/"/g, '""')}"`;
}
