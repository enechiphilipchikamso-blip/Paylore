import { describe, expect, it } from "vitest";
import { baseUnitsToUsdc, formatBaseUnits, usdcToBaseUnits } from "./reserve-funding-amount";

describe("ordinary USDC Reserve funding amounts", () => {
  it("converts exact six-decimal amounts without floating-point rounding", () => {
    expect(usdcToBaseUnits("1")).toBe("1000000");
    expect(usdcToBaseUnits("0.000001")).toBe("1");
    expect(usdcToBaseUnits("25.340001")).toBe("25340001");
  });

  it.each(["", "0", "0.0000001", "-1", "01", "1e3", "1,000"])(
    "rejects invalid or zero amount %s",
    (value) => expect(() => usdcToBaseUnits(value)).toThrow()
  );

  it("formats exact base units as readable USDC beside grouped base units", () => {
    expect(baseUnitsToUsdc("50000000")).toBe("50.00");
    expect(baseUnitsToUsdc("0")).toBe("0.00");
    expect(baseUnitsToUsdc("1")).toBe("0.000001");
    expect(baseUnitsToUsdc("1234567890123")).toBe("1,234,567.890123");
    expect(baseUnitsToUsdc("not-a-number")).toBeNull();
    expect(formatBaseUnits("50000000")).toBe("50,000,000");
  });
});
