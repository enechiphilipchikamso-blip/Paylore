import { describe, expect, it, vi } from "vitest";
import type { Database } from "./client";
import { acceptContributorInvitation } from "./repositories";

function queryBuilder(result: unknown) {
  const builder: Record<string, any> = {};
  for (const method of ["from", "innerJoin", "where", "for", "limit"]) builder[method] = vi.fn(() => builder);
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}
function updateBuilder(result: unknown, returningResult: unknown, calls: Array<Record<string, unknown>>) {
  const builder: Record<string, any> = {};
  builder.set = vi.fn((value: unknown) => { calls.push({ kind: "update", value }); return builder; });
  builder.where = vi.fn(() => builder);
  builder.returning = vi.fn(() => Promise.resolve(returningResult));
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}
function insertBuilder(returningResult: unknown, calls: Array<Record<string, unknown>>) {
  const builder: Record<string, any> = {};
  builder.values = vi.fn((value: unknown) => { calls.push({ kind: "insert", value }); return builder; });
  builder.onConflictDoNothing = vi.fn(() => builder);
  builder.returning = vi.fn(() => Promise.resolve(returningResult));
  return builder;
}
function fakeDatabase(
  role: "contributor" | "finance_auditor" | "organization_admin",
  lifecycle: "active" | "left" = "active"
) {
  const calls: Array<Record<string, unknown>> = [];
  const invitation = {
    id: "invitation-a", workspaceId: "workspace-a", contributorId: "contributor-a",
    acceptedAt: null, expiresAt: new Date("2026-11-01T00:00:00.000Z"),
    identityWalletAddress: "assigned-wallet", contributorRole: role, lifecycle
  };
  let updateCount = 0;
  const tx = {
    select: vi.fn(() => queryBuilder([invitation])),
    update: vi.fn(() => {
      updateCount += 1;
      return updateCount === 1 ? updateBuilder([], [{ id: "invitation-a" }], calls) : updateBuilder([], [], calls);
    }),
    insert: vi.fn(() => insertBuilder([{ role }], calls))
  };
  const db = { transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)) };
  return { db: db as unknown as Database, tx, calls };
}
describe("contributor invitation membership role", () => {
  it("grants the assigned Finance/Auditor role after the invitation wallet matches", async () => {
    const fixture = fakeDatabase("finance_auditor");
    const result = await acceptContributorInvitation(fixture.db, {
      tokenHash: "token-hash", userId: "assigned-user", walletAddress: "assigned-wallet",
      now: new Date("2026-10-24T00:00:00.000Z")
    });
    expect(result).toMatchObject({ workspaceId: "workspace-a", contributorId: "contributor-a", role: "finance_auditor" });
    expect(fixture.calls.find((call) => call.kind === "insert")?.value).toMatchObject({
      workspaceId: "workspace-a", userId: "assigned-user", role: "finance_auditor"
    });
  });
  it("does not reactivate a contributor who left after the invitation was created", async () => {
    const fixture = fakeDatabase("contributor", "left");
    const result = await acceptContributorInvitation(fixture.db, {
      tokenHash: "token-hash", userId: "assigned-user", walletAddress: "assigned-wallet",
      now: new Date("2026-10-24T00:00:00.000Z")
    });
    expect(result).toBeNull();
    expect(fixture.tx.update).not.toHaveBeenCalled();
    expect(fixture.tx.insert).not.toHaveBeenCalled();
  });

  it("does not let an invitation elevate a record to Organization Administrator", async () => {
    const fixture = fakeDatabase("organization_admin");
    const result = await acceptContributorInvitation(fixture.db, {
      tokenHash: "token-hash", userId: "assigned-user", walletAddress: "assigned-wallet",
      now: new Date("2026-10-24T00:00:00.000Z")
    });
    expect(result).toBeNull();
    expect(fixture.tx.update).not.toHaveBeenCalled();
    expect(fixture.tx.insert).not.toHaveBeenCalled();
  });
});
