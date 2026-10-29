# Paylore

Paylore is a private on-chain payroll platform for crypto-native organizations. It is designed to keep compensation amounts confidential within the confidential payroll system while preserving clear organization controls, contributor ownership, and organization-scoped records.

## Product

Paylore is built around a focused payroll model:

- confidential USDC compensation on Solana;
- durable wallet-based identity and secure application sessions;
- multiple independently scoped workspaces per user;
- organization, finance/auditor, and contributor roles;
- organization-controlled pre-claim recovery and contributor-controlled post-claim ownership;
- company-sponsored supported network fees;
- organization-scoped payroll, recovery, operations, and billing records;
- responsive, installable web experience with accessible public and authenticated surfaces.

The current authentication scope supports Phantom, Solflare, Backpack, and Jupiter Wallet Extension through desktop browser wallet connection. Mobile web presentation is supported, but mobile QR/remote wallet connection is not part of the current product scope.

## Repository

The repository is a pnpm workspace with:

- `apps/web/` — Next.js application, public portal, authenticated entry, workspace UI, and server routes.
- `packages/database/` — PostgreSQL/Supabase database boundary using Drizzle ORM and Postgres.js.
- `programs/payroll/` — Anchor/Solana program boundary.
- `.devcontainer/` — reproducible Codespaces development environment.
- `.github/workflows/ci.yml` — repository quality gates and Anchor build.

## Local development

Use Node.js 24.22.1 and pnpm 10.34.5.

Install dependencies:

```bash
pnpm install --frozen-lockfile
```

Before a QA regression run, set `PAYLORE_QA_DATABASE_URL` in the untracked
`.env.local` file and create a pre-regression backup:

```bash
pnpm db:backup:qa
```

The command verifies the connection, writes a custom-format dump to
`/tmp/paylore-qa/paylore-pre-regression.dump`, restricts the dump to the
current user, and lists its contents. Use a QA database URL only.
