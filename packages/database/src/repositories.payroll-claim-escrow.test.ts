import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { Database } from "./client";
import { createPayrollClaimEscrow } from "./repositories";

const escrowInput = {
  workspaceId: "workspace-a",
  payrollRunId: "run-a",
  allocationId: "allocation-a",
  claimId: "a".repeat(64),
  tokenAccountAddress: "escrow-token-account",
  encryptedPrivateKey: "k",
  privateKeyNonce: "n",
  privateKeyAuthTag: "t",
  encryptedDataKey: "dk",
  dataKeyNonce: "dn",
  dataKeyAuthTag: "dt",
  encryptedBackup: "b",
  backupNonce: "bn",
  backupAuthTag: "bt"
};

describe("payroll claim escrow creation", () => {
  it("accepts confirmed draft allocations because the escrow is bound into the Claim PDA instruction", async () => {
    let allocationWhere: SQL | undefined;
    const select = {
      from: vi.fn(() => select),
      where: vi.fn((condition: SQL) => { allocationWhere = condition; return select; }),
      limit: vi.fn(async () => [{ id: escrowInput.allocationId, claimId: escrowInput.claimId }])
    };
    const insert = {
      values: vi.fn(() => insert),
      onConflictDoNothing: vi.fn(() => insert),
      returning: vi.fn(async () => [{ ...escrowInput, status: "preparing" }])
    };
    const db = {
      select: vi.fn(() => select),
      insert: vi.fn(() => insert)
    } as unknown as Database;

    await expect(createPayrollClaimEscrow(db, escrowInput)).resolves.toMatchObject({ status: "created" });
    const rendered = new PgDialect().sqlToQuery(allocationWhere!);
    expect(rendered.sql).toMatch(/"status" in \(\$\d+, \$\d+\)/);
    expect(rendered.params).toEqual(expect.arrayContaining(["draft", "unclaimed"]));
  });
});
