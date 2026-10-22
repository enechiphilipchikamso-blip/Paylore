import { describe, expect, it } from "vitest";
import {
  getAutomaticContributorCleanupDisposition,
  getContributorDepartureDisposition,
  hasReachedInactivityThreshold,
  CONTRIBUTOR_ASSOCIATION_CLEANUP_DELAY_MS,
  isContributorAssociationCleanupEligible,
  isWorkspaceRetentionEligible,
  MANUAL_WORKSPACE_DELETION_DELAY_MS,
  scheduleWorkspaceDeletion,
  WORKSPACE_RETENTION_NOTICE_DAYS
} from "@paylore/database";

describe("workspace retention policy", () => {
  it("schedules manual deletion no sooner than 72 hours", () => {
    const requestedAt = new Date("2026-06-01T12:00:00.000Z");
    const scheduledAt = scheduleWorkspaceDeletion(requestedAt);

    expect(scheduledAt.getTime() - requestedAt.getTime()).toBe(
      MANUAL_WORKSPACE_DELETION_DELAY_MS
    );
    expect(MANUAL_WORKSPACE_DELETION_DELAY_MS).toBe(72 * 60 * 60 * 1000);
  });

  it("uses the approved idempotent inactivity milestones", () => {
    expect(WORKSPACE_RETENTION_NOTICE_DAYS).toEqual([
      30,
      90,
      180,
      270,
      330
    ]);
    const lastActivityAt = new Date("2026-01-01T00:00:00.000Z");
    const threshold = new Date(
      lastActivityAt.getTime() + 30 * 24 * 60 * 60 * 1000
    );

    expect(
      hasReachedInactivityThreshold(lastActivityAt, 30, threshold)
    ).toBe(true);
    expect(
      hasReachedInactivityThreshold(
        lastActivityAt,
        30,
        new Date(threshold.getTime() - 1)
      )
    ).toBe(false);
  });

  it("requires age, an unpaid/archived subscription, and no blockers for eligibility", () => {
    const eligible = {
      inactiveDays: 365,
      subscriptionStatus: "archived",
      gasTankConfigured: false,
      reserveConfigured: false,
      outstandingObligations: false
    };
    expect(isWorkspaceRetentionEligible(eligible)).toBe(true);
    expect(
      isWorkspaceRetentionEligible({
        ...eligible,
        inactiveDays: 364
      })
    ).toBe(false);
    expect(
      isWorkspaceRetentionEligible({
        ...eligible,
        subscriptionStatus: "active"
      })
    ).toBe(false);
    expect(
      isWorkspaceRetentionEligible({
        ...eligible,
        outstandingObligations: true
      })
    ).toBe(false);
  });

  it("records manual closure, leave-without-close, and automatic cleanup as distinct dispositions", () => {
    expect(getContributorDepartureDisposition(true)).toEqual({
      manualAccountClose: true,
      departureMode: "manual_close_and_leave",
      notificationBody: "Workspace access has been removed. Your wallet closed the confidential account; any eligible account rent was returned to your wallet."
    });
    expect(getContributorDepartureDisposition(false)).toEqual({
      manualAccountClose: false,
      departureMode: "leave_without_account_close",
      notificationBody: "Workspace access has been removed. Your confidential account remains under your control and was not closed by Paylore."
    });
    expect(getAutomaticContributorCleanupDisposition()).toEqual({
      manualAccountClose: false,
      departureMode: "automatic_association_cleanup",
      notificationBody: "Workspace access has been removed after the retention period. Your confidential account has not been closed by Paylore."
    });
  });

  it("waits 365 days after workspace closure and while compensation is unresolved", () => {
    const closedAt = new Date("2026-01-01T00:00:00.000Z");
    const dueAt = new Date(
      closedAt.getTime() + CONTRIBUTOR_ASSOCIATION_CLEANUP_DELAY_MS
    );
    expect(
      isContributorAssociationCleanupEligible({
        workspaceClosedAt: closedAt,
        outstandingObligations: false,
        now: new Date(dueAt.getTime() - 1)
      })
    ).toBe(false);
    expect(
      isContributorAssociationCleanupEligible({
        workspaceClosedAt: closedAt,
        outstandingObligations: true,
        now: dueAt
      })
    ).toBe(false);
    expect(
      isContributorAssociationCleanupEligible({
        workspaceClosedAt: closedAt,
        outstandingObligations: false,
        now: dueAt
      })
    ).toBe(true);
  });
});
