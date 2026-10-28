import { describe, expect, it, vi } from "vitest";
import type { Database } from "./client";
import { cleanupEligibleContributorAssociations } from "./repositories";

function query(result: unknown) {
  const builder: Record<string, unknown> = {};
  for (const method of ["from", "innerJoin", "where", "orderBy", "limit", "for"]) {
    builder[method] = vi.fn(() => builder);
  }
  builder.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return builder;
}

function mutation(calls: Array<{ method: string; value: unknown }>, method: string) {
  const builder: Record<string, unknown> = {};
  builder.values = vi.fn((value: unknown) => {
    calls.push({ method, value });
    return builder;
  });
  builder.set = vi.fn((value: unknown) => {
    calls.push({ method, value });
    return builder;
  });
  builder.where = vi.fn(() => Promise.resolve([]));
  builder.onConflictDoNothing = vi.fn(() => Promise.resolve([]));
  builder.onConflictDoUpdate = vi.fn(() => Promise.resolve([]));
  return builder;
}

function fakeDatabase(selectResults: unknown[][]) {
  const mutations: Array<{ method: string; value: unknown }> = [];
  const tx = {
    select: vi.fn(() => query(selectResults.shift() ?? [])),
    insert: vi.fn(() => mutation(mutations, "insert")),
    update: vi.fn(() => mutation(mutations, "update")),
    delete: vi.fn(() => mutation(mutations, "delete"))
  };
  const db = {
    select: vi.fn(() => query([{ contributorId: "contributor-a", workspaceId: "workspace-a" }])),
    transaction: vi.fn(async (callback: (transaction: typeof tx) => unknown) => callback(tx))
  };
  return { db: db as unknown as Database, tx, mutations };
}

describe("automatic contributor association cleanup", () => {
  it("removes only the association and records the non-close disposition after 365 days with settled obligations", async () => {
    const now = new Date("2026-10-22T12:00:00.000Z");
    const db = fakeDatabase([
      [{ id: "contributor-a", displayName: "Ada", identityWalletAddress: "contributor-wallet", lifecycle: "active" }],
      [{ closedAt: new Date(now.getTime() - 366 * 24 * 60 * 60 * 1000) }],
      [],
      [{ userId: "admin-user" }],
      [{ userId: "contributor-user" }]
    ]);

    await expect(cleanupEligibleContributorAssociations(db.db, now)).resolves.toEqual({
      removed: 1,
      deferred: 0
    });

    const inserts = db.mutations
      .filter((entry) => entry.method === "insert")
      .flatMap((entry) => Array.isArray(entry.value) ? entry.value : [entry.value]) as Record<string, unknown>[];
    const notifications = inserts.filter((value) =>
      value.eventKey === "contributor-association-cleanup:contributor-a"
    );
    expect(notifications).toHaveLength(2);
    expect(notifications).toContainEqual(expect.objectContaining({
      recipientKey: "contributor-user",
      title: "Workspace association removed",
      body: "Workspace access has been removed after the retention period. Your confidential account has not been closed by Paylore."
    }));
    expect(notifications).toContainEqual(expect.objectContaining({
      recipientKey: "admin-user",
      title: "Contributor workspace association removed",
      body: "Ada's workspace application association was removed after the retention period. Their confidential account and on-chain state were not closed or deleted by Paylore."
    }));
    expect(notifications.every((notice) =>
      notice.category === "Recovery & Offboarding" &&
      !("amountBaseUnits" in notice) &&
      !("walletAddress" in notice)
    )).toBe(true);
    const offboarding = inserts.find((value) => value.completedAt instanceof Date) as Record<string, unknown>;
    expect(offboarding).toMatchObject({
      manualAccountClose: false,
      closeTransactionSignature: null,
      status: "completed"
    });
    const ledger = inserts.find((value) => value.entryType === "contributor_association_cleanup") as Record<string, unknown>;
    expect(ledger.metadata).toEqual({
      manualAccountClose: false,
      departureMode: "automatic_association_cleanup"
    });
    expect(db.tx.delete).toHaveBeenCalledTimes(1);
    expect(db.tx.update).toHaveBeenCalledTimes(1);
  });

  it("defers association cleanup while a qualifying allocation remains open", async () => {
    const now = new Date("2026-10-22T12:00:00.000Z");
    const db = fakeDatabase([
      [{ id: "contributor-a", displayName: "Ada", identityWalletAddress: "contributor-wallet", lifecycle: "active" }],
      [{ closedAt: new Date(now.getTime() - 366 * 24 * 60 * 60 * 1000) }],
      [{ id: "allocation-a" }],
      [{ userId: "admin-user" }],
      [{ userId: "contributor-user" }]
    ]);

    await expect(cleanupEligibleContributorAssociations(db.db, now)).resolves.toEqual({
      removed: 0,
      deferred: 1
    });
    const inserts = db.mutations
      .filter((entry) => entry.method === "insert")
      .flatMap((entry) => Array.isArray(entry.value) ? entry.value : [entry.value]) as Record<string, unknown>[];
    expect(inserts).toContainEqual(expect.objectContaining({
      manualAccountClose: false,
      status: "deferred_obligations"
    }));
    expect(inserts).toContainEqual(expect.objectContaining({
      recipientKey: "admin-user",
      eventKey: expect.stringMatching(/^contributor-association-cleanup-deferred:contributor-a:/),
      title: "Contributor association cleanup deferred",
      body: "Cleanup for Ada's workspace association was deferred because qualifying compensation obligations remain. Resolve them before removing the association."
    }));
    expect(inserts).toContainEqual(expect.objectContaining({
      recipientKey: "contributor-user",
      eventKey: expect.stringMatching(/^contributor-association-cleanup-deferred:contributor-a:/),
      title: "Workspace association cleanup delayed",
      body: "Your workspace association remains active while qualifying compensation obligations are unresolved. Your confidential account has not been closed or changed."
    }));
    expect(inserts.filter((notice) =>
      typeof notice.eventKey === "string" &&
      notice.eventKey.startsWith("contributor-association-cleanup-deferred:")
    ).every((notice) => !("amountBaseUnits" in notice) && !("walletAddress" in notice))).toBe(true);
    expect(db.tx.delete).not.toHaveBeenCalled();
    expect(db.tx.update).not.toHaveBeenCalled();
  });
});
