import { describe, expect, it, vi } from "vitest";
import type { Database } from "./client";
import { acceptContributorInvitation, createContributorInvitation } from "./repositories";
import { contributorInvitations, invitationEntryTargets } from "./schema";

type Call = { kind: "update" | "insert"; table: unknown; value: unknown };

function selectBuilder(result: unknown) {
  const builder: Record<string, any> = {};
  for (const method of ["from", "innerJoin", "where", "for", "limit"]) builder[method] = vi.fn(() => builder);
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

function fakeDatabase(selects: unknown[][], updateReturning: (table: unknown) => unknown[]) {
  const calls: Call[] = [];
  const tx = {
    select: vi.fn(() => selectBuilder(selects.shift() ?? [])),
    update: vi.fn((table: unknown) => {
      const builder: Record<string, any> = {};
      builder.set = vi.fn((value: unknown) => { calls.push({ kind: "update", table, value }); return builder; });
      builder.where = vi.fn(() => builder);
      builder.returning = vi.fn(async () => updateReturning(table));
      builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve([]).then(resolve);
      return builder;
    }),
    insert: vi.fn((table: unknown) => {
      const builder: Record<string, any> = {};
      builder.values = vi.fn((value: unknown) => { calls.push({ kind: "insert", table, value }); return builder; });
      builder.onConflictDoNothing = vi.fn(() => builder);
      builder.returning = vi.fn(async () => [{ id: "invitation-new", role: "contributor" }]);
      builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve([]).then(resolve);
      return builder;
    })
  };
  const db = { transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx)) };
  return { db: db as unknown as Database, calls };
}

const now = new Date("2026-11-02T00:00:00.000Z");
const createInput = {
  tokenHash: "new-token-hash",
  workspaceId: "workspace-a",
  contributorId: "contributor-a",
  createdByUserId: "admin-user",
  expiresAt: new Date("2026-11-09T00:00:00.000Z"),
  now
};
const eligibleContributor = [{ walletAddress: "wallet-a", lifecycle: "invited", role: "contributor" }];

describe("contributor invitation de-duplication", () => {
  it("supersedes earlier open links for the same contributor when a new invitation is created", async () => {
    const fixture = fakeDatabase(
      [eligibleContributor, []],
      (table) => table === contributorInvitations ? [{ tokenHash: "old-token-hash" }] : []
    );
    const result = await createContributorInvitation(fixture.db, createInput);
    expect(result).toMatchObject({ id: "invitation-new", supersededCount: 1 });
    const expired = fixture.calls.filter((call) => call.kind === "update");
    expect(expired.map((call) => call.table)).toEqual([contributorInvitations, invitationEntryTargets]);
    expect(expired.every((call) => (call.value as { expiresAt: Date }).expiresAt === now)).toBe(true);
  });

  it("rejects a new link for a contributor who already accepted an invitation", async () => {
    const fixture = fakeDatabase([eligibleContributor, [{ id: "invitation-accepted" }]], () => []);
    await expect(createContributorInvitation(fixture.db, createInput))
      .rejects.toThrow("Contributor has already accepted an invitation.");
    expect(fixture.calls).toEqual([]);
  });

  it("expires the contributor's other open links when one invitation is accepted", async () => {
    const fixture = fakeDatabase([[{
      id: "invitation-a", workspaceId: "workspace-a", contributorId: "contributor-a",
      acceptedAt: null, expiresAt: new Date("2026-11-09T00:00:00.000Z"),
      identityWalletAddress: "wallet-a", contributorRole: "contributor", lifecycle: "invited"
    }]], (table) => table === contributorInvitations ? [{ id: "invitation-a", tokenHash: "duplicate-token-hash" }] : []);
    const result = await acceptContributorInvitation(fixture.db, {
      tokenHash: "token-hash", userId: "user-a", walletAddress: "wallet-a", now
    });
    expect(result).toMatchObject({ workspaceId: "workspace-a", contributorId: "contributor-a" });
    const updates = fixture.calls.filter((call) => call.kind === "update");
    expect(updates.at(-2)).toMatchObject({ table: contributorInvitations, value: { expiresAt: now } });
    expect(updates.at(-1)).toMatchObject({ table: invitationEntryTargets, value: { expiresAt: now } });
  });
});
