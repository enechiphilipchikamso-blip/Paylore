import { describe, expect, it } from "vitest";
import {
  csvCell,
  decodeLedgerCursor,
  encodeLedgerCursor,
  parseLedgerDate
} from "./ledger-policy";

describe("workspace ledger policy", () => {
  it("round-trips a stable timestamp and id cursor", () => {
    const cursor = {
      createdAt: new Date("2026-01-02T03:04:05.000Z"),
      id: "d7e9ef90-68b3-4a94-9a42-8ad987654321"
    };
    expect(decodeLedgerCursor(encodeLedgerCursor(cursor))).toEqual(cursor);
  });

  it("rejects malformed cursors", () => {
    expect(decodeLedgerCursor("not-a-cursor")).toBeNull();
    expect(
      decodeLedgerCursor(
        Buffer.from("not-a-date\nnot-a-uuid").toString("base64url")
      )
    ).toBeNull();
  });

  it("parses inclusive calendar-day filters as UTC bounds", () => {
    expect(parseLedgerDate("2026-10-13")?.toISOString())
      .toBe("2026-10-13T00:00:00.000Z");
    expect(parseLedgerDate("2026-10-13", true)?.toISOString())
      .toBe("2026-10-14T00:00:00.000Z");
    expect(parseLedgerDate("2026-02-30")).toBeNull();
  });

  it.each([
    ["=1+1", "\"'=1+1\""],
    ["  @SUM(A1)", "\"'  @SUM(A1)\""],
    ["a,\"b\"", "\"a,\"\"b\"\"\""]
  ])("safely encodes CSV cell %s", (input, expected) => {
    expect(csvCell(input)).toBe(expected);
  });
});
