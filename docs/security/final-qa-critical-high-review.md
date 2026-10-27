# Final QA — Critical/High-Severity Source Review

**Review date:** 2026-10-27  
**Review basis:** `dev-main` source at `7dd663be9905742f06fe9905797d4cf7d86aef09`, the combined Batch 08–15 scope, PRD, Architecture and Development Plan.  
**Purpose:** record source-level findings, their fixes, and the controls that the user's live Devnet/browser regression must still exercise.

## Executive disposition

- **Confirmed critical runtime findings:** none identified in this source review.
- **High-severity release-assurance findings:** four source/test-gate gaps are recorded below. All four have source changes in this Final QA batch.
- **External verification:** not performed by this review. This record does not claim that tests, typechecks, lint, builds, migrations, deployed-program parity, hosted workflows, live-wallet operations, or penetration testing passed.

## Findings and fixes

### FQA-HIGH-01 — The canonical unit-test command omitted important suites

**Type:** Release assurance / regression coverage  
**Finding:** `apps/web/vitest.config.mts` enumerated only selected database test files and only `src/**/*.test.ts`. That omitted most `packages/database/src/*.test.ts` coverage, rendered `.test.tsx` page tests, and Netlify worker `.test.mts` tests from `pnpm test`. A passing default test command could therefore leave substantial money/state-transition, retention, rendered-role and webhook-worker coverage unexecuted.

**Fix:**
- The Vitest include now covers `src/**/*.test.ts`, `src/**/*.test.tsx`, `../../packages/database/src/**/*.test.ts`, and `../../netlify/functions/**/*.test.mts`.
- `vitest@5.0.2` is explicitly declared for `@paylore/database`, with the matching workspace lockfile importer, so database-owned test modules resolve the test runner directly.

**Regression evidence:** `apps/web/vitest.config.mts`, `packages/database/package.json`, `pnpm-lock.yaml`; database settlement/recovery/payment/deletion/webhook tests; billing, deletion and reserve rendered page tests; Netlify webhook tests.

**Disposition:** FIXED IN SOURCE. Actual execution is still required.

### FQA-HIGH-02 — The combined local release gate did not check all critical source surfaces

**Type:** Release assurance / build integrity  
**Finding:** Root `pnpm check` did not run Drizzle migration consistency, Rust program unit tests, or an Anchor program build. The CI workflow also lacked explicit database migration consistency and Rust unit-test steps. This reduced the gate's ability to catch schema, on-chain instruction and generated-program drift before integrated QA.

**Fix:**
- Added `pnpm test:program-rust`, running `cargo test --locked --manifest-path programs/payroll/Cargo.toml`.
- Expanded `pnpm check` to run `pnpm db:check`, the Rust tests and `pnpm anchor:build` before the existing IDL/deployed-program script tests, lint, typecheck, unit tests, security scanners, build and Playwright run.
- Added `pnpm db:check` and `pnpm test:program-rust` as explicit CI steps. The existing CI Anchor build remains enabled.

**Regression evidence:** root `package.json`, `.github/workflows/ci.yml`, Rust tests in `programs/payroll/src/lib.rs`, migration files and Drizzle metadata.

**Disposition:** FIXED IN SOURCE. The gate has not been run in this review environment.

### FQA-HIGH-03 — Recovery-status output needed an explicit workspace boundary check

**Type:** Authorization / tenant isolation  
**Finding:** Recovery status retrieval already queried the escrow with workspace and allocation identifiers, but the route's final ownership check only compared the payroll-run identifier. The returned database record was not independently required to match the requested workspace before status was projected to the client. The route should fail closed if a future query implementation, mock, stale record, or repository regression returns a record outside that route scope.

**Fix:** The recovery GET route now rejects a missing escrow, a workspace mismatch, or a payroll-run mismatch as `not_available`. Regression tests cover foreign-workspace results, mismatched runs, non-admin access, and omission of encrypted custody fields.

**Regression evidence:** `apps/web/src/app/api/workspaces/[workspaceId]/payroll/runs/[runId]/allocations/[allocationId]/recovery/route.ts` and its `route.test.ts`.

**Disposition:** FIXED IN SOURCE in Batch 15 part 2; commit: https://github.com/enechiphilipchikamso-blip/Paylore/commit/7dd663be9905742f06fe9905797d4cf7d86aef09.

### FQA-HIGH-04 — Cross-workflow duplicate, race and deletion-blocker tests were incomplete

**Type:** Financial integrity / authorization / destructive-action safety  
**Finding:** Individual route/service tests existed, but the source did not fully tie together these threat cases: payment-signature reuse across tenants, repeated webhook provider events, claim competing with recovery, and final deletion while payroll/reserve/Gas Tank/confidential-account obligations remained.

**Fix and linked regression evidence:**
- Payment replay across different workspace/user: `packages/database/src/repositories.subscription-payment.test.ts`; same-workspace replay remains idempotent.
- Duplicate Helius event intake: `apps/web/src/app/api/webhooks/helius/route.test.ts` and `packages/database/src/repositories.webhook-ingest.test.ts`.
- Claim/recovery state conflicts: `packages/database/src/repositories.payroll-settlement.test.ts` and `packages/database/src/repositories.payroll-recovery.test.ts`.
- No destructive deletion with open confidential accounts, a reserve, open allocation/run or residual Gas Tank funds: `packages/database/src/repositories.workspace-deletion-purge.test.ts`; API refusal is asserted in `apps/web/src/app/api/workspaces/[workspaceId]/retention/route.test.ts`.
- Wrong workspace/member/role and recovery-status scope: the claim and recovery route tests, alongside the existing sponsor and billing role matrices.
- A cross-workflow matrix maps the risks to production guards and regression evidence in `tests/security/cross-workflow-threat-matrix.md`.

**Disposition:** FIXED IN SOURCE / TEST ARTIFACTS. Execution is required to record pass/fail results.

## Additional controls reviewed

The source review traced the following existing enforcement points relevant to money, credentials, tenant isolation and irreversible actions:

- Session tokens are opaque, stored as hashes and evaluated for inactivity/hard expiry; production cookies are HttpOnly and Secure.
- Same-origin request checks guard state-changing routes.
- Billing verifies the payment against the authenticated wallet, and the payment repository locks subscription state and rejects an already-used signature if the original payment belongs to another workspace or user.
- Confidential claim settlement requires a matching pending allocation and exact balance-delta evidence before final ledger state; a matching completed settlement is treated as an idempotent replay.
- Recovery requires the recovery-pending state, matching workspace/run/allocation/escrow references, and source debit plus reserve credit equal to the original allocation before writing recovered state and the ledger.
- Workspace purge locks the retention/audit state and refuses deletion until the waiting period and eligibility conditions hold and Gas Tank funds, confidential accounts, reserve records, payroll allocations and payroll runs have been checked. A repeated completed purge returns the retained terminal result.
- Helius intake authenticates the configured webhook secret and provider/event persistence uses a uniqueness conflict target; the processing code checks canonical RPC transaction binding and finalized ledger reconciliation.
- The client-artifact scanner examines generated JavaScript and source maps and does not print found secret values.

These are source-level observations, not a substitute for tests or a hosted security assessment.

## Residual risks and scope limitations

1. Do not treat source presence or a test file as a passed check. Run `pnpm check` from the pinned development environment and keep its complete output.
2. Hosted Devnet acceptance still needs the user-owned deployment, database migration, provider configuration, wallet interactions and browser regression described in the Handoff. Do not use real financial transactions until each stop condition in that runbook is met.
3. Run the hosted wrong-wallet, wrong-role, unauthorized webhook, duplicate delivery, claim-versus-recovery, recovery reconciliation and deletion-with-open-obligation checks in a dedicated Devnet workspace, capturing sanitized evidence and public signatures only.
4. Review the Netlify site-level Node runtime setting directly; repository code cannot prove an account/dashboard override.
5. No formal penetration test, independent cryptographic audit, live third-party provider check, production deployment approval or Mainnet authorization is included in this source review. Mainnet remains outside this Devnet completion scope.

## Review completion criteria

This record is complete as a source-level findings-and-fixes register. The implementation is ready for the separate **Real User QA: Final Batch Regression**. The user should record real command results, deployed commit identity, migration state, wallet/network observations, public transaction signatures and sanitized browser evidence in the handoff record. No external result is inferred here.
