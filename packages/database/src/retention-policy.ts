export const WORKSPACE_RETENTION_NOTICE_DAYS = [
  30,
  90,
  180,
  270,
  330
] as const;

export const MANUAL_WORKSPACE_DELETION_DELAY_MS = 72 * 60 * 60 * 1000;
export const WORKSPACE_RETENTION_ELIGIBILITY_DAYS = 365;
export const CONTRIBUTOR_ASSOCIATION_CLEANUP_DELAY_MS =
  WORKSPACE_RETENTION_ELIGIBILITY_DAYS * 24 * 60 * 60 * 1000;

export function scheduleWorkspaceDeletion(now: Date): Date {
  return new Date(now.getTime() + MANUAL_WORKSPACE_DELETION_DELAY_MS);
}

export function hasReachedInactivityThreshold(
  lastActivityAt: Date,
  days: number,
  now: Date
): boolean {
  return (
    now.getTime() - lastActivityAt.getTime() >=
    days * 24 * 60 * 60 * 1000
  );
}

export function isWorkspaceRetentionEligible(input: {
  inactiveDays: number;
  subscriptionStatus: string | null;
  gasTankConfigured: boolean;
  reserveConfigured: boolean;
  outstandingObligations: boolean;
}): boolean {
  return (
    input.inactiveDays >= WORKSPACE_RETENTION_ELIGIBILITY_DAYS &&
    (input.subscriptionStatus === "inactive" ||
      input.subscriptionStatus === "archived") &&
    !input.gasTankConfigured &&
    !input.reserveConfigured &&
    !input.outstandingObligations
  );
}

export function isContributorAssociationCleanupEligible(input: {
  workspaceClosedAt: Date | null;
  outstandingObligations: boolean;
  now: Date;
}): boolean {
  return Boolean(
    input.workspaceClosedAt &&
      !input.outstandingObligations &&
      input.now.getTime() - input.workspaceClosedAt.getTime() >=
        CONTRIBUTOR_ASSOCIATION_CLEANUP_DELAY_MS
  );
}


export type ContributorDepartureDisposition = {
  manualAccountClose: boolean;
  departureMode: "manual_close_and_leave" | "leave_without_account_close" | "automatic_association_cleanup";
  notificationBody: string;
};

/** Keeps manual wallet closure distinct from membership-only cleanup. */
export function getContributorDepartureDisposition(
  manualAccountClose: boolean
): ContributorDepartureDisposition {
  return manualAccountClose
    ? {
        manualAccountClose: true,
        departureMode: "manual_close_and_leave",
        notificationBody: "Workspace access has been removed. Your wallet closed the confidential account; any eligible account rent was returned to your wallet."
      }
    : {
        manualAccountClose: false,
        departureMode: "leave_without_account_close",
        notificationBody: "Workspace access has been removed. Your confidential account remains under your control and was not closed by Paylore."
      };
}

export function getAutomaticContributorCleanupDisposition(): ContributorDepartureDisposition {
  return {
    manualAccountClose: false,
    departureMode: "automatic_association_cleanup",
    notificationBody: "Workspace access has been removed after the retention period. Your confidential account has not been closed by Paylore."
  };
}


export const SUBSCRIPTION_RENEWAL_REMINDER_DAYS = [7, 1] as const;

/** Reminder milestones are retried throughout their due window; durable event keys provide idempotency. */
export function getDueSubscriptionRenewalReminderDays(
  periodEnd: Date,
  now: Date
): Array<(typeof SUBSCRIPTION_RENEWAL_REMINDER_DAYS)[number]> {
  const remainingMs = periodEnd.getTime() - now.getTime();
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return [];
  const dayMs = 24 * 60 * 60 * 1000;
  if (remainingMs <= dayMs) return [1];
  if (remainingMs <= 7 * dayMs) return [7];
  return [];
}
