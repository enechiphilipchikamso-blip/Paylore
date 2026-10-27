#!/usr/bin/env bash
set -euo pipefail

# Use user-owned toolchain paths explicitly; non-interactive bash does not
# reliably source shell profile PATH additions made by installers.
export PATH="$HOME/.cargo/bin:$HOME/.avm/bin:$HOME/.local/share/solana/install/active_release/bin:$PATH"

if ! command -v rustup >/dev/null 2>&1; then
  echo "Rustup is missing; rebuild the Codespace so the pinned devcontainer installs it." >&2
  exit 1
fi

expected_node="24.22.1"
expected_node_binary="/usr/local/share/nvm/versions/node/v${expected_node}/bin/node"
actual_node="$(node --version | sed 's/^v//')"
actual_node_command="$(command -v node)"
actual_node_path="$(node -p 'process.execPath')"

if [[ "$actual_node" != "$expected_node" ]]; then
  echo "Expected Node.js ${expected_node}, found ${actual_node}." >&2
  exit 1
fi

if [[ "$actual_node_command" != "$expected_node_binary" || "$actual_node_path" != "$expected_node_binary" ]]; then
  echo "Expected Node.js executable ${expected_node_binary}; found command ${actual_node_command} and runtime path ${actual_node_path}." >&2
  exit 1
fi

corepack enable
corepack install --global pnpm@10.34.5

rustup toolchain install \
  1.89.0 \
  --profile minimal \
  --component rustfmt \
  --component clippy

rustup default 1.89.0

if ! command -v solana >/dev/null 2>&1 || ! solana --version | grep -Eq '(^|[[:space:]])4\\.1\\.2([[:space:]]|$)'; then
  sh -c "$(curl -sSfL https://release.anza.xyz/v4.1.2/install)"
fi

export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$HOME/.avm/bin:$PATH"

cargo install \
  --git https://github.com/otter-sec/anchor \
  avm \
  --force

avm install 1.2.0
avm use 1.2.0

solana config set --url devnet

pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium

actual_node="$(node --version | sed 's/^v//')"
actual_pnpm="$(pnpm --version)"
actual_rust="$(rustc --version | awk '{print $2}')"
actual_cargo="$(cargo --version | awk '{print $2}')"
actual_anchor="$(anchor --version | awk '{print $NF}')"
actual_solana="$(solana --version | awk '{print $2}')"

require_version() {
  local name="$1"
  local expected="$2"
  local actual="$3"
  if [[ "$actual" != "$expected" ]]; then
    printf 'Expected %s %s, found %s.\\n' "$name" "$expected" "$actual" >&2
    exit 1
  fi
}

require_version "Node.js" "24.22.1" "$actual_node"
require_version "pnpm" "10.34.5" "$actual_pnpm"
require_version "Rust" "1.89.0" "$actual_rust"
require_version "Cargo" "1.89.0" "$actual_cargo"
require_version "Anchor CLI" "1.2.0" "$actual_anchor"
require_version "Solana CLI" "4.1.2" "$actual_solana"

node --version
pnpm --version
rustc --version
cargo --version
anchor --version
solana --version