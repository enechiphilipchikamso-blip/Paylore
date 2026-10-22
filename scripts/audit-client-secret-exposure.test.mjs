import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

const scannerPath = fileURLToPath(new URL("./audit-client-secret-exposure.mjs", import.meta.url));

async function withFixture(run) {
  const root = await mkdtemp(join(tmpdir(), "paylore-secret-audit-"));
  try {
    const staticDirectory = join(root, "apps", "web", ".next", "static");
    await mkdir(staticDirectory, { recursive: true });
    await run({ root, staticDirectory });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function runScanner(root, target, env = {}) {
  return spawnSync(process.execPath, [scannerPath, target], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", ...env }
  });
}

test("reports a server key found in JavaScript and source maps without printing the value", async () => {
  await withFixture(async ({ root, staticDirectory }) => {
    const secret = "test-only-gas-tank-envelope-secret-9173";
    await writeFile(join(root, ".env.local"), `PAYLORE_GAS_TANK_ENVELOPE_KEY=${secret}\n`);
    await writeFile(join(staticDirectory, "main.js"), `window.config = "${secret}";`);
    await writeFile(join(staticDirectory, "main.js.map"), JSON.stringify({
      version: 3,
      sources: ["main.ts"],
      sourcesContent: [`const leaked = "${secret}";`]
    }));

    const result = runScanner(root, staticDirectory);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PAYLORE_GAS_TANK_ENVELOPE_KEY/);
    assert.match(result.stderr, /main\.js/);
    assert.match(result.stderr, /main\.js\.map/);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
  });
});

test("rejects a server-only configuration name in browser code even without a value leak", async () => {
  await withFixture(async ({ root, staticDirectory }) => {
    await writeFile(join(staticDirectory, "chunk.js"), "const keyName = 'PAYLORE_RESERVE_ENVELOPE_KEY';");
    const result = runScanner(root, staticDirectory);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PAYLORE_RESERVE_ENVELOPE_KEY/);
    assert.doesNotMatch(result.stdout + result.stderr, /actual-secret-value/);
  });
});

test("does not mistake the public Solana Devnet endpoint for a credential", async () => {
  await withFixture(async ({ root, staticDirectory }) => {
    const publicEndpoint = "https://api.devnet.solana.com";
    await writeFile(join(root, ".env.local"), `PAYLORE_RPC_PRIMARY_URL=${publicEndpoint}\n`);
    await writeFile(join(staticDirectory, "chunk.js"), `const endpoint = "${publicEndpoint}";`);
    const result = runScanner(root, staticDirectory);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Secret exposure audit clear/);
  });
});

test("detects an API key embedded in a provider URL even when only the key is copied", async () => {
  await withFixture(async ({ root, staticDirectory }) => {
    const secret = "helius-query-secret-8f3d6c";
    await writeFile(join(root, ".env.local"), `PAYLORE_RPC_PRIMARY_URL=https://devnet.helius-rpc.com/?api-key=${secret}\n`);
    await writeFile(join(staticDirectory, "chunk.js"), `const accidentalKey = "${secret}";`);
    const result = runScanner(root, staticDirectory);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /PAYLORE_RPC_PRIMARY_URL api-key/);
    assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secret));
  });
});

test("fails with a distinct error when a requested scan target does not exist", async () => {
  await withFixture(async ({ root }) => {
    const result = runScanner(root, resolve(root, "missing-build-output"));
    assert.equal(result.status, 2);
    assert.match(result.stderr, /Target does not exist/);
  });
});
