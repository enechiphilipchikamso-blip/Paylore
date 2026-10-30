import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("contributor compensation action feedback", () => {
  it("routes asynchronous contributor operations through the shared busy button", async () => {
    const source = await readFile(
      new URL("../components/workspace/ContributorCompensation.tsx", import.meta.url),
      "utf8"
    );

    expect(source).toContain('import { BusyActionButton } from "./BusyActionButton"');
    expect(source).not.toMatch(/<button\b/);

    for (const action of [
      "claim",
      "refresh",
      "apply",
      "cashout",
      "unwrap",
      "leave",
      "verify_setup",
      "ledger"
    ]) {
      expect(source).toContain(`busyAction === "${action}"`);
    }
  });

  it("preserves explicit success, partial, and error outcomes for contributor actions", async () => {
    const source = await readFile(
      new URL("../components/workspace/ContributorCompensation.tsx", import.meta.url),
      "utf8"
    );

    expect(source).toContain('<ClaimAndCashOutStatus message={message} />');
    expect(source).toContain('state: "success"');
    expect(source).toContain('state: "partial"');
    expect(source).toContain('state: "error"');
    expect(source).toContain("Do not submit a duplicate transaction");
  });
});
