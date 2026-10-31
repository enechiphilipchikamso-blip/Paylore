import { describe, expect, it } from "vitest";
import type { Database } from "./client";
import { beginWorkspaceReserveFundingOperation } from "./repositories";
import { RESERVE_FUNDING_OPERATION_TYPE } from "./reserve-funding-operation-policy";
import { gasTankOperations, workspaceReserves } from "./schema";

type BeginInput = {
  workspaceId: string;
  idempotencyKey: string;
  requestDigest: string;
  wrapSignature: string;
  operationData: Record<string, unknown>;
};

type StoredOperation = BeginInput & {
  id: string;
  operationType: string;
  status: string;
  transactionSignature: string;
  feeLamports: string;
};

function createRepositoryDatabase() {
  const reserves = new Set(["workspace-a", "workspace-b"]);
  const operations: StoredOperation[] = [];
  const lockedTables: unknown[] = [];
  let forcedExisting: StoredOperation | null = null;
  let operationSequence = 0;
  let transactionTail: Promise<void> = Promise.resolve();
  let currentInput: BeginInput | null = null;

  const db = {
    run(request: BeginInput) {
      currentInput = request;
      return beginWorkspaceReserveFundingOperation(db as unknown as Database, request);
    },
    forceExistingRow(row: StoredOperation | null) {
      forcedExisting = row;
    },
    operations,
    lockedTables,
    async transaction<T>(callback: (tx: any) => Promise<T>): Promise<T> {
      const previous = transactionTail;
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      transactionTail = previous.then(() => gate);
      await previous;
      let operationSelectCount = 0;

      const tx = {
        select() {
          const builder: Record<string, any> = {};
          let selectedTable: unknown;
          builder.from = (table: unknown) => { selectedTable = table; return builder; };
          builder.where = () => builder;
          builder.for = (lock: string) => {
            if (lock === "update") lockedTables.push(selectedTable);
            return builder;
          };
          builder.limit = () => builder;
          builder.then = (
            resolve: (value: unknown) => unknown,
            reject?: (reason: unknown) => unknown
          ) => {
            let rows: unknown[] = [];
            if (selectedTable === workspaceReserves) {
              const workspaceId = currentInput?.workspaceId;
              rows = workspaceId && reserves.has(workspaceId) ? [{ workspaceId }] : [];
            } else if (selectedTable === gasTankOperations) {
              operationSelectCount++;
              const request = currentInput;
              if (request && operationSelectCount === 1) {
                rows = forcedExisting
                  ? [forcedExisting]
                  : operations.filter((row) =>
                      row.workspaceId === request.workspaceId &&
                      row.idempotencyKey === request.idempotencyKey
                    ).slice(0, 1);
              } else if (request && operationSelectCount === 2) {
                rows = operations.filter((row) =>
                  row.workspaceId === request.workspaceId &&
                  row.operationType === RESERVE_FUNDING_OPERATION_TYPE &&
                  ["preparing", "prepared"].includes(row.status)
                ).slice(0, 1);
              } else if (request && operationSelectCount === 3) {
                rows = operations.filter((row) =>
                  row.workspaceId === request.workspaceId &&
                  row.idempotencyKey === request.idempotencyKey
                ).slice(0, 1);
              }
            }
            return Promise.resolve(rows).then(resolve, reject);
          };
          return builder;
        },
        insert() {
          const builder: Record<string, any> = {};
          let values: Record<string, unknown> = {};
          builder.values = (next: Record<string, unknown>) => { values = next; return builder; };
          builder.onConflictDoNothing = () => builder;
          builder.returning = async () => {
            const request = values as BeginInput;
            const duplicate = operations.some((row) =>
              row.workspaceId === request.workspaceId &&
              row.idempotencyKey === request.idempotencyKey
            );
            if (duplicate) return [];
            const row = {
              ...values,
              id: "reserve-operation-" + (++operationSequence),
              operationType: RESERVE_FUNDING_OPERATION_TYPE,
              status: "preparing",
              transactionSignature: request.wrapSignature,
              feeLamports: "0"
            } as StoredOperation;
            operations.push(row);
            return [row];
          };
          return builder;
        }
      };

      try {
        return await callback(tx);
      } finally {
        release();
      }
    }
  };
  return db;
}

function request(overrides: Partial<BeginInput> = {}): BeginInput {
  const wrapSignature = "s".repeat(88);
  return {
    workspaceId: "workspace-a",
    idempotencyKey: "reserve_funding:" + wrapSignature,
    requestDigest: "a".repeat(64),
    wrapSignature,
    operationData: { amountBaseUnits: "1000000", walletAddress: "admin-wallet" },
    ...overrides
  };
}

describe("beginWorkspaceReserveFundingOperation repository idempotency", () => {
  it("creates a workspace-scoped operation while locking the Reserve and operation rows", async () => {
    const fake = createRepositoryDatabase();
    const input = request();

    const result = await fake.run(input);

    expect(result.status).toBe("created");
    expect(result.operation).toMatchObject({
      workspaceId: input.workspaceId,
      idempotencyKey: input.idempotencyKey,
      requestDigest: input.requestDigest,
      transactionSignature: input.wrapSignature,
      operationType: RESERVE_FUNDING_OPERATION_TYPE,
      status: "preparing",
      operationData: { stage: "wrap_verified", amountBaseUnits: "1000000" }
    });
    expect(fake.operations).toHaveLength(1);
    expect(fake.lockedTables).toContain(workspaceReserves);
    expect(fake.lockedTables).toContain(gasTankOperations);
  });

  it("returns the existing operation for an identical same-signature replay", async () => {
    const fake = createRepositoryDatabase();
    const input = request();
    const first = await fake.run(input);
    const replay = await fake.run(input);

    expect(first.status).toBe("created");
    expect(replay.status).toBe("existing");
    expect(replay.operation?.id).toBe(first.operation?.id);
    expect(fake.operations).toHaveLength(1);
  });

  it("conflicts when the same idempotency key is replayed with a different request digest", async () => {
    const fake = createRepositoryDatabase();
    const input = request();
    await fake.run(input);

    const replay = await fake.run({
      ...input,
      requestDigest: "b".repeat(64)
    });

    expect(replay.status).toBe("conflict");
    expect(replay.operation?.requestDigest).toBe(input.requestDigest);
    expect(fake.operations).toHaveLength(1);
  });

  it("rejects a stored operation returned for a different workspace", async () => {
    const fake = createRepositoryDatabase();
    const input = request();
    await fake.run(input);
    fake.forceExistingRow(fake.operations[0]!);

    const replay = await fake.run({
      ...input,
      workspaceId: "workspace-b"
    });

    expect(replay.status).toBe("conflict");
    expect(replay.operation?.workspaceId).toBe("workspace-a");
    expect(fake.operations).toHaveLength(1);
  });

  it("serializes simultaneous creates so one transaction creates and the other reuses the same operation", async () => {
    const fake = createRepositoryDatabase();
    const input = request();

    const [first, second] = await Promise.all([
      fake.run(input),
      fake.run(input)
    ]);

    expect([first.status, second.status].sort()).toEqual(["created", "existing"]);
    expect(first.operation?.id).toBe(second.operation?.id);
    expect(fake.operations).toHaveLength(1);
    expect(fake.lockedTables.filter((table) => table === workspaceReserves)).toHaveLength(2);
  });
});
