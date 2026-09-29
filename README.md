# Paylore

Paylore is a private on-chain payroll platform for crypto-native organizations.

## Batch 01 Foundation

Batch 01 establishes the reproducible development foundation only.

Included:

- pnpm workspace
- Next.js / React / TypeScript web foundation
- Node.js 24
- Rust / Anchor / Solana CLI tooling
- GitHub Codespaces
- Solana Devnet configuration
- minimal application boot
- safe backend health endpoint
- PostgreSQL / Supabase connectivity baseline
- GitHub Actions CI
- Playwright smoke testing
- lint / typecheck / test / build quality gates
- repository hygiene
- Netlify deployment skeleton

No payroll, wallet authentication, workspace, subscription, contributor, Token-2022, reserve, Gas Tank, claim, recovery, ledger, retention, or deletion feature is implemented in Batch 01.

## Exact Batch 01 Versions

| Component | Version |
|---|---|
| Node.js | 24.21.0 |
| pnpm | 10.34.5 |
| Next.js | 16.3.6 |
| React | 19.3.0 |
| React DOM | 19.3.0 |
| TypeScript | 6.0.3 |
| ESLint | 10.10.0 |
| eslint-config-next | 16.3.6 |
| Zod | 4.6.5 |
| Drizzle ORM | 0.45.3 |
| Postgres.js | 3.4.9 |
| Vitest | 5.0.2 |
| Playwright | 1.63.0 |
| Rust | 1.89.0 |
| Anchor CLI | 1.2.0 |
| Solana CLI | 4.1.2 |

## Repository Structure

```text
paylore/
├── .devcontainer/
├── .github/
│   └── workflows/
├── apps/
│   └── web/
│       └── src/
│           ├── app/
│           └── server/
├── packages/
│   └── database/
│       └── src/
├── programs/
│   └── payroll/
├── tests/
│   └── e2e/
├── .env.example
├── Anchor.toml
├── Cargo.toml
├── netlify.toml
├── package.json
├── pnpm-workspace.yaml
├── playwright.config.ts
├── rust-toolchain.toml
└── tsconfig.base.json