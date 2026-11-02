const U64_MAX = (1n << 64n) - 1n;

export function usdcToBaseUnits(value: string): string {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) {
    throw new Error("Enter a USDC amount with up to six decimal places.");
  }
  const [whole, fraction = ""] = value.split(".");
  const amount = BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
  if (amount <= 0n || amount > U64_MAX) {
    throw new Error("Enter a positive USDC amount within the supported range.");
  }
  return amount.toString();
}

const groupDigits = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

/** Formats exact base units as readable USDC without floating-point rounding. */
export function baseUnitsToUsdc(value: string): string | null {
  if (!/^(0|[1-9]\d*)$/.test(value)) return null;
  const amount = BigInt(value);
  const whole = (amount / 1_000_000n).toString();
  const fraction = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return groupDigits(whole) + "." + fraction.padEnd(2, "0");
}

export function formatBaseUnits(value: string): string {
  return /^\d+$/.test(value) ? groupDigits(value) : value;
}
