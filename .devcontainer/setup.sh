#!/usr/bin/env bash
set -euo pipefail

expected_node="24.21.0"
actual_node="$(node --version | sed 's/^v//')"

if [[ "$actual_node" != "$expected_node" ]]; then
  echo "Expected Node.js ${expected_node}, found ${actual_node}." >&2
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

if ! command -v solana >/dev/null 2>&1 || ! solana --version | grep -q '4.1.2'; then
  sh -c "$(curl -sSfL https://release.anza.xyz/v4.1.2/install)"
fi

export PATH="$HOME/.local/share/solana/install/active_release/bin:$PATH"

cargo install \
  --git https://github.com/otter-sec/anchor \
  avm \
  --force

avm install 1.2.0
avm use 1.2.0

solana config set --url devnet

pnpm install --frozen-lockfile
pnpm exec playwright install --with-deps chromium

node --version
pnpm --version
rustc --version
cargo --version
anchor --version
solana --version