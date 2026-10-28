import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import process from "node:process";

const expected = "24.22.1";
const root = process.cwd();

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

const errors = [];
const packageJson = JSON.parse(read("package.json"));
const webPackage = JSON.parse(read("apps/web/package.json"));
const databasePackage = JSON.parse(read("packages/database/package.json"));
const dockerfile = read(".devcontainer/Dockerfile");
const setup = read(".devcontainer/setup.sh");
const netlify = read("netlify.toml");
const workflow = read(".github/workflows/ci.yml");
const readme = read("README.md");

function expect(condition, label) {
  if (!condition) errors.push(label);
}

expect(packageJson.engines?.node === expected, "root package.json engines.node must be 24.22.1");
expect(read(".node-version").trim() === expected, ".node-version must contain only 24.22.1");
expect(
  dockerfile.includes("FROM mcr.microsoft.com/devcontainers/typescript-node:24-trixie") &&
  dockerfile.includes("nvm install 24.22.1") &&
  dockerfile.includes("nvm alias default 24.22.1") &&
  dockerfile.includes("/usr/local/share/nvm/versions/node/v24.22.1/bin"),
  "Codespaces Dockerfile must preserve Trixie and select the nvm-managed 24.22.1 executable"
);
expect(
  setup.includes('expected_node="24.22.1"') &&
  setup.includes('/usr/local/share/nvm/versions/node/v${expected_node}/bin/node') &&
  setup.includes('actual_node_path="$(node -p \'process.execPath\')"'),
  "Codespaces setup must validate the selected Node 24.22.1 executable"
);
expect(/NODE_VERSION\s*=\s*"24\.22\.1"/.test(netlify), "netlify.toml NODE_VERSION must be 24.22.1");
expect(/node-version:\s*24\.22\.1/.test(workflow), "GitHub Actions Node pin must be 24.22.1");
expect(readme.includes("Use Node.js 24.22.1"), "README local-development guidance must match the pinned patch");
for (const [label, manifest] of [["apps/web/package.json", webPackage], ["packages/database/package.json", databasePackage]]) {
  expect(!manifest.engines?.node || manifest.engines.node === expected, `${label} has a conflicting Node engine declaration`);
}
if (existsSync(resolve(root, ".nvmrc"))) {
  expect(read(".nvmrc").trim() === expected, ".nvmrc must match the repository Node patch");
}
expect(process.version === "v" + expected, `current Node runtime must be v${expected}; found ${process.version}`);

if (errors.length) {
  console.error("Node.js runtime pin audit failed:");
  for (const error of errors) console.error("- " + error);
  process.exitCode = 1;
} else {
  console.log(JSON.stringify({
    event: "node_runtime_pin_audit",
    expectedVersion: "v" + expected,
    executablePath: process.execPath,
    checked: [
      "package.json",
      ".node-version",
      ".devcontainer/Dockerfile",
      ".devcontainer/setup.sh",
      "netlify.toml",
      ".github/workflows/ci.yml",
      "README.md",
      "apps/web/package.json",
      "packages/database/package.json"
    ],
    note: "Netlify site-level AWS_LAMBDA_JS_RUNTIME overrides are outside repository source and must be reviewed in Netlify settings."
  }));
}
