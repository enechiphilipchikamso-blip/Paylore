import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const functionsDir = resolve(import.meta.dirname, "../../netlify/functions");
const IMPORT_PATTERN = /(?:import|export)\s[^"']*?from\s*["']([^"']+)["']|import\s*["']([^"']+)["']/g;

function resolveRelative(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base, base.replace(/\.m?js$/, ".mts"), `${base}.ts`, `${base}.mts`, join(base, "index.ts")];
  return candidates.find((candidate) => existsSync(candidate) && candidate.match(/\.m?ts$/)) ?? null;
}

function serverOnlyImporters(entry: string): string[] {
  const seen = new Set<string>();
  const importers: string[] = [];
  const pending = [entry];
  while (pending.length) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    for (const match of readFileSync(file, "utf8").matchAll(IMPORT_PATTERN)) {
      const specifier = match[1] ?? match[2];
      if (specifier === "server-only") importers.push(file);
      if (!specifier.startsWith(".")) continue;
      const next = resolveRelative(file, specifier);
      if (next) pending.push(next);
    }
  }
  return importers;
}

describe("Netlify Functions server-only boundary", () => {
  // Functions are bundled by Netlify's esbuild, where "server-only" is not
  // resolvable and would crash the function at load time.
  for (const name of readdirSync(functionsDir).filter((file) => file.endsWith(".mts"))) {
    it(`${name} does not import server-only modules`, () => {
      expect(serverOnlyImporters(join(functionsDir, name))).toEqual([]);
    });
  }
});
