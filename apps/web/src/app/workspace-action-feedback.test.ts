import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("workspace action progress treatment", () => {
  it("shows a visible spinner for busy buttons and respects reduced-motion preferences", async () => {
    const styles = await readFile(new URL("./globals.css", import.meta.url), "utf8");
    expect(styles).toContain('button[aria-busy="true"]::before');
    expect(styles).toContain("workspace-action-spin");
    expect(styles).toContain("@media (prefers-reduced-motion: reduce)");
  });
});
