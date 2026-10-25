import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  archiveExpiredWorkspaceSubscriptions: vi.fn(),
  cleanupEligibleContributorAssociations: vi.fn(),
  createDueSubscriptionRenewalReminders: vi.fn(),
  createDatabase: vi.fn(),
  createWorkspaceRetentionNotice: vi.fn(),
  hasReachedInactivityThreshold: vi.fn(),
  listDueWorkspaceRetentionNotifications: vi.fn(),
  parseConfig: vi.fn()
}));

vi.mock("../../../../packages/database/src/index", () => ({
  archiveExpiredWorkspaceSubscriptions: mocks.archiveExpiredWorkspaceSubscriptions,
  cleanupEligibleContributorAssociations: mocks.cleanupEligibleContributorAssociations,
  createDueSubscriptionRenewalReminders: mocks.createDueSubscriptionRenewalReminders,
  createDatabase: mocks.createDatabase,
  createWorkspaceRetentionNotice: mocks.createWorkspaceRetentionNotice,
  hasReachedInactivityThreshold: mocks.hasReachedInactivityThreshold,
  listDueWorkspaceRetentionNotifications: mocks.listDueWorkspaceRetentionNotifications,
  WORKSPACE_RETENTION_NOTICE_DAYS: [30, 90, 180, 270, 330]
}));

vi.mock("../../../../apps/web/src/server/config", () => ({
  parseConfig: mocks.parseConfig
}));

import processWorkspaceRetention, { config } from "../../../../netlify/functions/process-workspace-retention";

describe("scheduled subscription reminder delivery", () => {
  const db = {};
  const client = { end: vi.fn(async () => undefined) };

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.parseConfig.mockReturnValue({ DATABASE_URL: "postgres://database.example/paylore" });
    mocks.createDatabase.mockReturnValue({ db, client });
    mocks.archiveExpiredWorkspaceSubscriptions.mockResolvedValue(0);
    mocks.cleanupEligibleContributorAssociations.mockResolvedValue({ removed: 0, deferred: 0 });
    mocks.createDueSubscriptionRenewalReminders.mockResolvedValue({
      subscriptionsProcessed: 1,
      notificationsCreated: 2,
      ledgerEntriesCreated: 1
    });
    mocks.listDueWorkspaceRetentionNotifications.mockResolvedValue([]);
  });

  it("runs reminder persistence on the scheduled path and reports both durable outcomes", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);

    expect(config.schedule).toBe("0 8 * * *");
    await processWorkspaceRetention();

    expect(mocks.createDueSubscriptionRenewalReminders).toHaveBeenCalledOnce();
    expect(mocks.createDueSubscriptionRenewalReminders).toHaveBeenCalledWith(db, expect.any(Date), 500);
    expect(mocks.listDueWorkspaceRetentionNotifications).toHaveBeenCalledWith(db, expect.any(Date), 500);
    const completion = JSON.parse(String(log.mock.calls[0]?.[0]));
    expect(completion).toMatchObject({
      event: "workspace_retention_processing_completed",
      subscriptionRemindersCreated: 2,
      subscriptionReminderLedgerEntriesCreated: 1,
      subscriptionsWithDueReminders: 1
    });
    expect(client.end).toHaveBeenCalledWith({ timeout: 5 });
    log.mockRestore();
  });

  it("does not log a successful run when reminder persistence fails and still closes the database client", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    mocks.createDueSubscriptionRenewalReminders.mockRejectedValueOnce(new Error("reminder persistence failed"));

    await expect(processWorkspaceRetention()).rejects.toThrow("reminder persistence failed");

    expect(log).not.toHaveBeenCalled();
    expect(client.end).toHaveBeenCalledWith({ timeout: 5 });
    log.mockRestore();
  });
});
