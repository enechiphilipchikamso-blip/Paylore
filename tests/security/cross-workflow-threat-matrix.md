# Paylore cross-workflow security and regression matrix

This matrix connects security threats to production enforcement points and regression assertions. The source artifacts do not assert that tests or hosted Devnet QA have been executed.

| Threat / workflow | Enforcement point | Regression coverage and required outcome |
|---|---|---|
| Wrong contributor wallet claims another allocation | Claim route and settlement service | `apps/web/src/app/api/workspaces/[workspaceId]/payroll/runs/[runId]/allocations/[allocationId]/claim/route.test.ts`: wallet mismatch returns not-found and settlement is not invoked; `apps/web/src/server/solana/payroll-confidential-settlement.test.ts`: settlement does not start for a different contributor wallet. |
| Wrong workspace, non-member, or wrong role accesses claim, sponsor, billing, recovery, or deletion | Workspace membership and route-level role guards | Claim, sponsor, billing, recovery and retention route tests assert cross-workspace/non-member rejection, role boundaries, and that protected financial/destructive services are not called after rejection. |
| Same subscription payment signature is replayed | Subscription repository idempotency | `packages/database/src/repositories.subscription-payment.test.ts`: replay returns `duplicate: true` with one payment, one ledger entry and idempotent notices; billing route exposes duplicate status and binds verification to the session wallet. |
| Payment signature is reused by another workspace or user | Subscription signature uniqueness and ownership check | `packages/database/src/repositories.subscription-payment.test.ts`: cross-workspace/user reuse is rejected without extra payment, ledger or notice rows. |
| Helius delivers one provider event repeatedly | Provider/provider-event conflict target | `packages/database/src/repositories.webhook-ingest.test.ts` asserts existing provider-event conflict becomes a duplicate; `apps/web/src/app/api/webhooks/helius/route.test.ts` acknowledges the replay with zero new inserts. |
| Claim races with recovery | Settlement and recovery status transitions under row locks | `packages/database/src/repositories.payroll-settlement.test.ts`: claim start conflicts when the target is `recovery_pending`, and a competing recovery blocks a new claim. `packages/database/src/repositories.payroll-recovery.test.ts`: recovery conflicts after settlement has reserved the allocation and writes no financial rows. |
| Workspace deletion runs with open obligations | Transactional `permanentlyDeleteEligibleWorkspace` eligibility checks | `packages/database/src/repositories.workspace-deletion-purge.test.ts` covers open allocations, runs, confidential accounts, an unclosed reserve and residual Gas Tank funds; each persists a blocker and performs no delete. Retention route test returns a locked response, not `deleted`. |
| Recovery status crosses workspace/run boundaries or leaks custody material | Recovery GET scoping and response projection | `apps/web/src/app/api/workspaces/[workspaceId]/payroll/runs/[runId]/allocations/[allocationId]/recovery/route.test.ts`: foreign workspace/run is `not_available`, non-admin cannot read/submit recovery, and encrypted custody data is absent. |
| Pending, failed or blocked result is shown as completed | Claim/recovery/retention response contracts and existing rendered-state tests | Claim keeps pending/conflict distinct; recovery returns `valueTransferred: false` when pending/retry-ready; retention does not return `deleted` with open payroll obligations. Existing compensation, reserve-readiness, deletion-page role, and responsive browser-harness coverage is reused. |
| Server credential leaks into client artifacts | Client-artifact scanner | Existing `scripts/audit-client-secret-exposure.mjs` and `.test.mjs` remain the scanner. Hosted scan execution and deployed-artifact observation remain in the user QA runbook. |

## UI and accessibility boundaries

- Keep authentication, authorization, not-found, conflict, pending and locked outcomes distinguishable; do not label pending payment, recovery or deletion as complete.
- Do not expose custody/private-key internals or unrelated-workspace recovery state in response JSON.
- Role-restricted billing/deletion screens, reserve readiness copy, contributor compensation states, responsive browser harnesses and client-secret scanning are existing coverage reused here, not reimplemented.
- Record test or hosted QA results only after actually running those checks.
