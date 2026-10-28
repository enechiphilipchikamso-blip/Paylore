import { describe, expect, it, vi } from "vitest";
import { getTableName } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import type { Database } from "./client";
import {
  listWorkspaceDeadLetterSolanaWebhookEvents,
  retryDeadLetterSolanaWebhookEvent
} from "./repositories";

type Trace = {
  tableName: string | null;
  selection: Record<string, { name?: string }> | undefined;
  whereCondition?: unknown;
  joins: string[];
};

type Fixture = {
  tableRows: Record<string, Array<Record<string, unknown>>>;
  traces: Trace[];
  updates: Array<{ tableName: string; values: Record<string, unknown>; whereCondition?: unknown }>;
};

function makeSelectBuilder(selection: Record<string, { name?: string }> | undefined, fixture: Fixture) {
  const trace: Trace = { tableName: null, selection, joins: [] };
  fixture.traces.push(trace);
  const builder: Record<string, any> = {};
  builder.from = vi.fn((table: unknown) => {
    trace.tableName = getTableName(table as never);
    return builder;
  });
  builder.where = vi.fn((condition: unknown) => {
    trace.whereCondition = condition;
    return builder;
  });
  for (const name of ["innerJoin", "leftJoin", "orderBy", "limit", "for"]) {
    builder[name] = vi.fn((...args: unknown[]) => {
      if (name === "innerJoin" || name === "leftJoin") trace.joins.push(name);
      return builder;
    });
  }
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
    const tableName = trace.tableName ?? "";
    let rows = [...(fixture.tableRows[tableName] ?? [])];
    if (tableName === "solana_webhook_events" && trace.whereCondition) {
      const query = new PgDialect().sqlToQuery(trace.whereCondition as never);
      const values = query.params;
      const hasStatusFilter = query.sql.includes('"status" =');
      const hasIdFilter = query.sql.includes('"id" =');
      const hasAddressScope = query.sql.includes('"account_address" in');
      const hasSignatureScope = query.sql.includes('"transaction_signature" in');
      rows = rows.filter((row) => {
        const statusMatches = !hasStatusFilter || values.includes(row.status);
        const idMatches = !hasIdFilter || values.includes(row.id);
        const scopeMatches =
          (hasAddressScope && values.includes(row.account_address)) ||
          (hasSignatureScope && values.includes(row.transaction_signature));
        return statusMatches && idMatches && scopeMatches;
      });
    }
    const projected = rows.map((row) => Object.fromEntries(
      Object.entries(selection ?? {}).map(([alias, column]) => [alias, row[column.name ?? alias] ?? null])
    ));
    return Promise.resolve(projected).then(resolve, reject);
  };
  return builder;
}

function makeFixture(overrides: Record<string, Array<Record<string, unknown>>> = {}) {
  const fixture: Fixture = {
    tableRows: {
      workspace_reserves: [{
        address: "reserve-a",
        confidential_account_setup_signature: "reserve-setup-signature",
        program_reserve_setup_signature: null
      }],
      workspace_gas_tanks: [{ address: "gas-a" }],
      contributor_confidential_accounts: [{
        token_account_address: "confidential-a",
        setup_transaction_signature: "account-setup-signature",
        close_transaction_signature: null
      }],
      payroll_allocations: [{
        claim_address: "claim-a",
        transaction_signature: "payroll-signature",
        settlement_signature: "settlement-signature"
      }],
      gas_tank_operations: [{ transaction_signature: "gas-operation-signature" }],
      contributor_offboarding: [{ close_transaction_signature: "offboarding-signature" }],
      payroll_recoveries: [{ transaction_signature: "recovery-signature" }],
      payroll_runs: [{ submission_signature: "run-signature" }],
      subscription_payments: [{ signature: "subscription-signature" }],
      subscription_payment_attempts: [{ signature: "attempt-signature" }],
      solana_webhook_events: [
        {
          id: "d7e9ef90-68b3-4a94-9a42-8ad987654321",
          transaction_signature: "payroll-signature",
          transaction_slot: "42",
          account_address: "unrelated-account-hint",
          event_type: "payroll-create_claim",
          status: "dead_letter",
          attempts: 8,
          last_error_code: "repeated_rpc_failure",
          received_at: new Date("2026-10-25T10:00:00.000Z"),
          processed_at: null
        },
        {
          id: "b3e1058b-4e40-43e2-95a1-000000000001",
          transaction_signature: "foreign-signature",
          transaction_slot: "43",
          account_address: "foreign-account",
          event_type: "UNKNOWN",
          status: "dead_letter",
          attempts: 8,
          last_error_code: "unmapped",
          received_at: new Date("2026-10-25T11:00:00.000Z"),
          processed_at: null
        }
      ],
      ...overrides
    },
    traces: [],
    updates: []
  };

  const select = vi.fn((selection?: Record<string, { name?: string }>) =>
    makeSelectBuilder(selection, fixture)
  );
  const update = vi.fn((table: unknown) => {
    const tableName = getTableName(table as never);
    const builder: Record<string, any> = {};
    builder.set = vi.fn((values: Record<string, unknown>) => {
      fixture.updates.push({ tableName, values });
      return builder;
    });
    builder.where = vi.fn((condition: unknown) => {
      const lastUpdate = fixture.updates[fixture.updates.length - 1];
      if (lastUpdate) lastUpdate.whereCondition = condition;
      return builder;
    });
    builder.returning = vi.fn(() => builder);
    builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
      Promise.resolve([{ id: "d7e9ef90-68b3-4a94-9a42-8ad987654321" }]).then(resolve, reject);
    return builder;
  });
  const tx = { select, update };
  const db = {
    select,
    update,
    transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx))
  };
  return { fixture, db: db as unknown as Database };
}

function eventQuery(fixture: Fixture) {
  const trace = fixture.traces.find((item) => item.tableName === "solana_webhook_events");
  if (!trace?.whereCondition) throw new Error("Expected a workspace-scoped webhook-event query.");
  return new PgDialect().sqlToQuery(trace.whereCondition as never);
}

describe("workspace dead-letter event scope", () => {
  it("lists an event linked by an application transaction even when no ledger entry exists", async () => {
    const { fixture, db } = makeFixture();
    const events = await listWorkspaceDeadLetterSolanaWebhookEvents(db, {
      workspaceId: "workspace-a",
      limit: 100
    });

    expect(events).toEqual([{
      id: "d7e9ef90-68b3-4a94-9a42-8ad987654321",
      transactionSignature: "payroll-signature",
      transactionSlot: "42",
      eventType: "payroll-create_claim",
      status: "dead_letter",
      attempts: 8,
      lastErrorCode: "repeated_rpc_failure",
      receivedAt: new Date("2026-10-25T10:00:00.000Z"),
      processedAt: null
    }]);
    const query = eventQuery(fixture);
    expect(query.sql).toContain('"transaction_signature" in');
    expect(query.sql).toContain('"account_address" in');
    expect(query.params).toContain("payroll-signature");
    expect(query.params).toContain("reserve-a");
    expect(query.params).not.toContain("foreign-signature");
    expect(query.params).not.toContain("foreign-account");
    expect(fixture.traces.find((trace) => trace.tableName === "solana_webhook_events")?.joins).toEqual([]);
  });

  it("retries a scoped dead letter without a ledger row and resets retry bookkeeping", async () => {
    const { fixture, db } = makeFixture();
    await expect(retryDeadLetterSolanaWebhookEvent(db, {
      workspaceId: "workspace-a",
      eventId: "d7e9ef90-68b3-4a94-9a42-8ad987654321",
      now: new Date("2026-10-25T12:00:00.000Z")
    })).resolves.toBe(true);

    const query = eventQuery(fixture);
    expect(query.sql).toContain('"id" =');
    expect(query.sql).toContain('"status" =');
    expect(query.sql).toContain('"transaction_signature" in');
    expect(query.params).toContain("payroll-signature");
    expect(fixture.updates).toHaveLength(1);
    expect(fixture.updates[0]).toMatchObject({
      tableName: "solana_webhook_events",
      values: {
        status: "retry_pending",
        attempts: 0,
        nextAttemptAt: new Date("2026-10-25T12:00:00.000Z"),
        lastErrorCode: null,
        processedAt: null,
        finalizedAt: null
      }
    });
    const updateQuery = new PgDialect().sqlToQuery(fixture.updates[0].whereCondition as never);
    expect(updateQuery.sql).toContain('"transaction_signature" in');
    expect(updateQuery.params).toContain("payroll-signature");
  });

  it("does not list or retry unassociated events", async () => {
    const { fixture, db } = makeFixture({
      workspace_reserves: [],
      workspace_gas_tanks: [],
      contributor_confidential_accounts: [],
      payroll_allocations: [],
      gas_tank_operations: [],
      contributor_offboarding: [],
      payroll_recoveries: [],
      payroll_runs: [],
      subscription_payments: [],
      subscription_payment_attempts: []
    });
    await expect(listWorkspaceDeadLetterSolanaWebhookEvents(db, {
      workspaceId: "workspace-a"
    })).resolves.toEqual([]);
    await expect(retryDeadLetterSolanaWebhookEvent(db, {
      workspaceId: "workspace-a",
      eventId: "d7e9ef90-68b3-4a94-9a42-8ad987654321"
    })).resolves.toBe(false);
    expect(fixture.traces.filter((trace) => trace.tableName === "solana_webhook_events")).toHaveLength(0);
    expect(fixture.updates).toEqual([]);
  });
});
