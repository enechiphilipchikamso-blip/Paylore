import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_ROOT = join(__dirname, "..", "..");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|tsx)$/.test(entry) && !/\.test\.(ts|tsx)$/.test(entry) ? [path] : [];
  });
}

const withoutComments = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

describe("transaction plan execution", () => {
  it("never uses the concurrent-leaves executor", () => {
    // It starts every step at once. A plan whose second step depends on the first (create the
    // proof account, then verify the proof into it) raced and stranded confidential transfers.
    const files = sourceFiles(SOURCE_ROOT);
    expect(files.length).toBeGreaterThan(50); // the scan really covers the source tree
    const offenders = files.filter((file) =>
      withoutComments(readFileSync(file, "utf8")).includes("createTransactionPlanExecutorWithConcurrentLeaves")
    );
    expect(offenders).toEqual([]);
  });

  it("builds every server transaction plan through the shared sequential runner", () => {
    const runners = [
      "payroll-confidential-settlement.ts",
      "payroll-confidential-recovery.ts",
      "payroll-claim-escrow.ts",
      "workspace-reserve.ts"
    ];
    for (const runner of runners) {
      const text = readFileSync(join(__dirname, runner), "utf8");
      expect(text, runner).toContain("executeTransactionPlanSequentially");
    }
  });
});
