import { canTransitionSubscriptionPaymentAttemptStatus, type SubscriptionPaymentAttemptStatus } from "./subscription-payment-attempt-policy";
import { RESERVE_FUNDING_OPERATION_TYPE } from "./reserve-funding-operation-policy";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  gt,
  inArray,
  isNotNull,
  isNull,
  lte,
  lt,
  notInArray,
  or,
  sql
} from "drizzle-orm";
import {
  randomUUID
} from "node:crypto";
import type {
  Database
} from "./client";
import {
  operationDataForGasTankRetry,
  summarizeGasTankSponsorshipBudget,
  sumPreparedSponsoredRentReservations
} from "./gas-tank-operation-history";
import {
  CONTRIBUTOR_ASSOCIATION_CLEANUP_DELAY_MS,
  getDueSubscriptionRenewalReminderDays,
  getSubscriptionDaysRemaining,
  hasReachedInactivityThreshold,
  isContributorAssociationCleanupEligible,
  isWorkspaceRetentionEligible,
  getContributorDepartureDisposition,
  getAutomaticContributorCleanupDisposition,
  scheduleWorkspaceDeletion
} from "./retention-policy";
import {
  contributorInvitations,
  payrollAllocations,
  payrollClaimEscrows,
  payrollRecoveries,
  payrollRuns,
  solanaWebhookEvents,
  solanaReconciliationCursors,
  contributors,
  contributorConfidentialAccounts,
  contributorOffboarding,
  authChallenges,
  invitationEntryTargets,
  sessions,
  subscriptionPayments,
  subscriptionPaymentAttempts,
  workspaceGasTanks,
  gasTankOperations,
  workspaceLedgerEntries,
  workspaceReserves,
  workspaceSubscriptions,
  users,
  walletIdentities,
  workspaceCreationRateLimits,
  workspaceDeletionAudit,
  workspaceMemberships,
  workspaceNotifications,
  userNotifications,
  workspaceRetention,
  workspaces
} from "./schema";

export async function findAuthChallenge(
  db: Database,
  nonce: string
) {
  const rows =
    await db
      .select()
      .from(
        authChallenges
      )
      .where(
        eq(
          authChallenges.nonce,
          nonce
        )
      )
      .limit(1);

  return rows[0] ?? null;
}

export async function insertAuthChallenge(
  db: Database,
  input: {
    nonce: string;
    walletAddress: string;
    challengeInput: unknown;
    message: string;
    issuedAt: Date;
    expirationTime: Date;
  }
) {
  await db
    .insert(authChallenges)
    .values({
      nonce: input.nonce,
      walletAddress:
        input.walletAddress,
      input:
        input.challengeInput,
      message:
        input.message,
      issuedAt:
        input.issuedAt,
      expirationTime:
        input.expirationTime
    });
}

export async function consumeAuthChallenge(
  db: Database,
  nonce: string,
  now: Date
): Promise<boolean> {
  const rows =
    await db
      .update(
        authChallenges
      )
      .set({
        consumedAt: now
      })
      .where(
        and(
          eq(
            authChallenges.nonce,
            nonce
          ),
          isNull(
            authChallenges.consumedAt
          ),
          gt(
            authChallenges.expirationTime,
            now
          )
        )
      )
      .returning({
        nonce:
          authChallenges.nonce
      });

  return rows.length === 1;
}

export async function findOrCreateUserWalletIdentity(
  db: Database,
  walletAddress: string
) {
  const existing =
    await db
      .select({
        userId:
          walletIdentities.userId,
        walletIdentityId:
          walletIdentities.id
      })
      .from(
        walletIdentities
      )
      .where(
        eq(
          walletIdentities.address,
          walletAddress
        )
      )
      .limit(1);

  if (existing[0]) {
    return existing[0];
  }

  return db.transaction(
    async (tx) => {
      const userId =
        randomUUID();

      const walletIdentityId =
        randomUUID();

      await tx
        .insert(users)
        .values({
          id: userId
        });

      const inserted =
        await tx
          .insert(
            walletIdentities
          )
          .values({
            id:
              walletIdentityId,
            userId,
            address:
              walletAddress
          })
          .onConflictDoNothing({
            target:
              walletIdentities.address
          })
          .returning({
            id:
              walletIdentities.id,
            userId:
              walletIdentities.userId
          });

      if (inserted.length === 1) {
        return {
          userId:
            inserted[0].userId,
          walletIdentityId:
            inserted[0].id
        };
      }

      await tx
        .delete(users)
        .where(
          eq(
            users.id,
            userId
          )
        );

      const concurrent =
        await tx
          .select({
            userId:
              walletIdentities.userId,
            walletIdentityId:
              walletIdentities.id
          })
          .from(
            walletIdentities
          )
          .where(
            eq(
              walletIdentities.address,
              walletAddress
            )
          )
          .limit(1);

      if (!concurrent[0]) {
        throw new Error(
          "Wallet identity could not be established."
        );
      }

      return concurrent[0];
    }
  );
}

export async function createSession(
  db: Database,
  input: {
    rawTokenHash: string;
    userId: string;
    walletIdentityId: string;
    issuedAt: Date;
    lastSeenAt: Date;
    expiresAt: Date;
  }
) {
  const inserted =
    await db
      .insert(sessions)
      .values({
        tokenHash:
          input.rawTokenHash,
        userId:
          input.userId,
        walletIdentityId:
          input.walletIdentityId,
        issuedAt:
          input.issuedAt,
        lastSeenAt:
          input.lastSeenAt,
        expiresAt:
          input.expiresAt
      })
      .returning({
        id: sessions.id
      });

  if (!inserted[0]) {
    throw new Error(
      "Session could not be created."
    );
  }

  return inserted[0];
}

export async function findSessionByTokenHash(
  db: Database,
  tokenHash: string
) {
  const rows =
    await db
      .select({
        id: sessions.id,
        userId:
          sessions.userId,
        walletIdentityId:
          sessions.walletIdentityId,
        walletAddress:
          walletIdentities.address,
        issuedAt:
          sessions.issuedAt,
        lastSeenAt:
          sessions.lastSeenAt,
        expiresAt:
          sessions.expiresAt
      })
      .from(sessions)
      .innerJoin(
        walletIdentities,
        eq(
          sessions.walletIdentityId,
          walletIdentities.id
        )
      )
      .where(
        and(
          eq(
            sessions.tokenHash,
            tokenHash
          ),
          isNull(
            sessions.revokedAt
          )
        )
      )
      .limit(1);

  return rows[0] ?? null;
}

export async function touchSession(
  db: Database,
  sessionId: string,
  lastSeenAt: Date
): Promise<void> {
  await db
    .update(sessions)
    .set({
      lastSeenAt
    })
    .where(
      and(
        eq(
          sessions.id,
          sessionId
        ),
        isNull(
          sessions.revokedAt
        )
      )
    );
}

export async function revokeSessionById(
  db: Database,
  sessionId: string,
  revokedAt: Date
): Promise<void> {
  await db
    .update(sessions)
    .set({
      revokedAt
    })
    .where(
      eq(
        sessions.id,
        sessionId
      )
    );
}

export async function revokeSessionByTokenHash(
  db: Database,
  tokenHash: string,
  revokedAt: Date
): Promise<void> {
  await db
    .update(sessions)
    .set({
      revokedAt
    })
    .where(
      and(
        eq(
          sessions.tokenHash,
          tokenHash
        ),
        isNull(
          sessions.revokedAt
        )
      )
    );
}

export async function listWorkspaceMemberships(
  db: Database,
  userId: string
) {
  return db
    .select({
      workspaceId:
        workspaces.id,
      workspaceName:
        workspaces.name,
      role:
        workspaceMemberships.role,
      createdAt:
        workspaces.createdAt
    })
    .from(
      workspaceMemberships
    )
    .innerJoin(
      workspaces,
      eq(
        workspaceMemberships.workspaceId,
        workspaces.id
      )
    )
    .where(
      eq(
        workspaceMemberships.userId,
        userId
      )
    )
    .orderBy(
      asc(
        workspaces.createdAt
      )
    );
}

export async function getWorkspaceForUser(
  db: Database,
  userId: string,
  workspaceId: string,
  options: { recordActivity?: boolean } = {}
) {
  const rows =
    await db
      .select({
        workspaceId:
          workspaces.id,
        workspaceName:
          workspaces.name,
        role:
          workspaceMemberships.role
      })
      .from(
        workspaceMemberships
      )
      .innerJoin(
        workspaces,
        eq(
          workspaceMemberships.workspaceId,
          workspaces.id
        )
      )
      .where(
        and(
          eq(
            workspaceMemberships.userId,
            userId
          ),
          eq(
            workspaceMemberships.workspaceId,
            workspaceId
          )
        )
      )
      .limit(1);

  const workspace = rows[0] ?? null;
  if (workspace && options.recordActivity !== false) {
    const now = new Date();
    await db
      .insert(workspaceRetention)
      .values({ workspaceId, lastActivityAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: workspaceRetention.workspaceId,
        set: {
          lastActivityAt: now,
          lastNoticeDay: 0,
          updatedAt: now
        }
      });
  }

  return workspace;
}

export async function createWorkspaceWithAdminMembership(
  db: Database,
  input: {
    userId: string;
    name: string;
  }
) {
  const workspaceId =
    randomUUID();

  await db.transaction(
    async (tx) => {
      await tx
        .insert(workspaces)
        .values({
          id: workspaceId,
          name: input.name,
          createdByUserId:
            input.userId
        });

      await tx
        .insert(
          workspaceMemberships
        )
        .values({
          workspaceId,
          userId: input.userId,
          role:
            "organization_admin"
        });

      await tx
        .insert(workspaceSubscriptions)
        .values({
          workspaceId,
          status: "inactive"
        });

      await tx
        .insert(workspaceRetention)
        .values({ workspaceId });
    }
  );

  return {
    workspaceId
  };
}

export async function consumeWorkspaceCreationAttempt(
  db: Database,
  userId: string
): Promise<{
  attemptCount: number;
  elapsedSeconds: number;
}> {
  const result =
    await db.execute(sql`
      INSERT INTO "workspace_creation_rate_limits"
        ("user_id", "window_started_at", "attempt_count")
      VALUES
        (${userId}, now(), 1)
      ON CONFLICT ("user_id")
      DO UPDATE SET
        "attempt_count" =
          CASE
            WHEN now() - "workspace_creation_rate_limits"."window_started_at"
              >= interval '15 minutes'
            THEN 1
            ELSE "workspace_creation_rate_limits"."attempt_count" + 1
          END,
        "window_started_at" =
          CASE
            WHEN now() - "workspace_creation_rate_limits"."window_started_at"
              >= interval '15 minutes'
            THEN now()
            ELSE "workspace_creation_rate_limits"."window_started_at"
          END
      RETURNING
        "attempt_count",
        extract(
          epoch FROM (
            now() - "window_started_at"
          )
        ) AS "elapsed_seconds"
    `);

  const row =
    result[0] as
      | {
          attempt_count:
            | number
            | string;
          elapsed_seconds:
            | number
            | string;
        }
      | undefined;

  if (!row) {
    throw new Error(
      "Workspace creation rate limit state could not be read."
    );
  }

  return {
    attemptCount:
      Number(
        row.attempt_count
      ),
    elapsedSeconds:
      Number(
        row.elapsed_seconds
      )
  };
}

export async function findInvitationEntryTarget(
  db: Database,
  tokenHash: string,
  now: Date
) {
  const rows =
    await db
      .select({
        invitationId:
          contributorInvitations.id,
        contributorId:
          contributorInvitations.contributorId,
        workspaceId:
          contributorInvitations.workspaceId,
        workspaceName:
          workspaces.name,
        contributorWalletAddress:
          contributors.identityWalletAddress,
        contributorName:
          contributors.displayName,
        contributorRole: contributors.role,
        acceptedAt:
          contributorInvitations.acceptedAt,
        expiresAt:
          contributorInvitations.expiresAt
      })
      .from(
        contributorInvitations
      )
      .innerJoin(
        workspaces,
        eq(
          contributorInvitations.workspaceId,
          workspaces.id
        )
      )
      .innerJoin(
        contributors,
        eq(
          contributorInvitations.contributorId,
          contributors.id
        )
      )
      .where(
        eq(
          contributorInvitations.tokenHash,
          tokenHash
        )
      )
      .limit(1);

  const invitation = rows[0];
  if (
    !invitation ||
    invitation.expiresAt <= now ||
    invitation.acceptedAt ||
    invitation.contributorRole === "organization_admin"
  ) {
    return null;
  }

  return invitation;
}

async function ensureWorkspaceArchivedNotification(
  db: Database,
  input: {
    workspaceId: string;
    periodEnd: Date;
    now: Date;
  }
) {
  const members = await db
    .select({ userId: workspaceMemberships.userId })
    .from(workspaceMemberships)
    .where(eq(workspaceMemberships.workspaceId, input.workspaceId));
  if (members.length === 0) return;
  await db
    .insert(workspaceNotifications)
    .values(
      members.map((member) => ({
        workspaceId: input.workspaceId,
        recipientKey: member.userId,
        eventKey: `workspace-archived:${input.workspaceId}:${input.periodEnd.getTime()}`,
        category: "Workspace & Billing",
        title: "Workspace is now in Read-Only Archive",
        body: "This workspace subscription has expired. Existing qualifying claims and obligations remain available for settlement. New paid-only changes are unavailable until the workspace is renewed.",
        destination: `/workspace/${input.workspaceId}/billing`,
        createdAt: input.now
      }))
    )
    .onConflictDoNothing({
      target: [
        workspaceNotifications.workspaceId,
        workspaceNotifications.eventKey,
        workspaceNotifications.recipientKey
      ]
    });
}

export async function getWorkspaceSubscription(
  db: Database,
  workspaceId: string,
  now = new Date()
) {
  const rows =
    await db
      .select()
      .from(workspaceSubscriptions)
      .where(
        eq(
          workspaceSubscriptions.workspaceId,
          workspaceId
        )
      )
      .limit(1);

  const subscription = rows[0];
  if (
    !subscription ||
    !subscription.periodEnd ||
    subscription.periodEnd > now ||
    (subscription.status !== "active" &&
      subscription.status !== "cancel_scheduled")
  ) {
    if (subscription?.status === "archived" && subscription.periodEnd) {
      await ensureWorkspaceArchivedNotification(db, {
        workspaceId,
        periodEnd: subscription.periodEnd,
        now
      });
    }
    return subscription ?? null;
  }

  const archived =
    await db
      .update(workspaceSubscriptions)
      .set({
        status: "archived",
        cancelAtPeriodEnd: false,
        updatedAt: now
      })
      .where(
        and(
          eq(
            workspaceSubscriptions.workspaceId,
            workspaceId
          ),
          lte(
            workspaceSubscriptions.periodEnd,
            now
          ),
          or(
            eq(
              workspaceSubscriptions.status,
              "active"
            ),
            eq(
              workspaceSubscriptions.status,
              "cancel_scheduled"
            )
          )
        )
      )
      .returning();

  if (archived[0]) {
    await db
      .insert(workspaceRetention)
      .values({
        workspaceId,
        closedAt: now,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: workspaceRetention.workspaceId,
        set: { closedAt: now, updatedAt: now }
      });
  }

  await ensureWorkspaceArchivedNotification(db, {
    workspaceId,
    periodEnd: subscription.periodEnd,
    now
  });

  return archived[0] ?? {
    ...subscription,
    status: "archived" as const,
    cancelAtPeriodEnd: false
  };
}

function addCalendarMonth(value: Date): Date {
  const next = new Date(value);
  const day = next.getUTCDate();
  next.setUTCDate(1);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const lastDay = new Date(
    Date.UTC(
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      0
    )
  ).getUTCDate();
  next.setUTCDate(Math.min(day, lastDay));
  return next;
}

export async function createSubscriptionPaymentAttempt(
  db: Database,
  input: {
    id: string;
    workspaceId: string;
    userId: string;
    payerWalletAddress: string;
    recipient: string;
    mint: string;
    amountBaseUnits: string;
    memo: string;
    blockhash: string;
    lastValidBlockHeight: number;
    expiresAt: Date;
    now?: Date;
  }
) {
  const now = input.now ?? new Date();
  const rows = await db
    .insert(subscriptionPaymentAttempts)
    .values({
      id: input.id,
      workspaceId: input.workspaceId,
      userId: input.userId,
      payerWalletAddress: input.payerWalletAddress,
      recipient: input.recipient,
      mint: input.mint,
      amountBaseUnits: input.amountBaseUnits,
      memo: input.memo,
      blockhash: input.blockhash,
      lastValidBlockHeight: input.lastValidBlockHeight,
      status: "prepared",
      expiresAt: input.expiresAt,
      createdAt: now,
      updatedAt: now
    })
    .returning();
  if (!rows[0]) throw new Error("The subscription payment attempt was not stored.");
  return rows[0];
}

export async function getSubscriptionPaymentAttempt(
  db: Database,
  attemptId: string
) {
  const rows = await db
    .select()
    .from(subscriptionPaymentAttempts)
    .where(eq(subscriptionPaymentAttempts.id, attemptId))
    .limit(1);
  return rows[0] ?? null;
}

export async function recordSubscriptionPaymentAttemptSignature(
  db: Database,
  input: { attemptId: string; signature: string; now?: Date }
) {
  const now = input.now ?? new Date();
  const rows = await db
    .update(subscriptionPaymentAttempts)
    .set({
      status: "submitted",
      signature: input.signature,
      updatedAt: now
    })
    .where(
      and(
        eq(subscriptionPaymentAttempts.id, input.attemptId),
        or(
          eq(subscriptionPaymentAttempts.status, "prepared"),
          and(
            eq(subscriptionPaymentAttempts.status, "submitted"),
            eq(subscriptionPaymentAttempts.signature, input.signature)
          )
        )
      )
    )
    .returning();
  if (rows[0]) return rows[0];
  const existing = await getSubscriptionPaymentAttempt(db, input.attemptId);
  if (existing?.signature === input.signature) return existing;
  throw new Error("The subscription payment attempt has a different submitted signature.");
}

export async function updateSubscriptionPaymentAttemptStatus(
  db: Database,
  input: {
    attemptId: string;
    status: "confirmed" | "expired" | "failed";
    signature: string | null;
    now?: Date;
  }
) {
  const now = input.now ?? new Date();
  const existing = await getSubscriptionPaymentAttempt(db, input.attemptId);
  if (!existing) return null;

  const currentStatus = existing.status as SubscriptionPaymentAttemptStatus;
  const currentSignature = existing.signature ?? null;
  if (!canTransitionSubscriptionPaymentAttemptStatus({
    currentStatus,
    currentSignature,
    nextStatus: input.status,
    nextSignature: input.signature
  })) return null;

  if (currentStatus === input.status && currentSignature === input.signature) {
    return existing;
  }

  const expectedState = [
    eq(subscriptionPaymentAttempts.id, input.attemptId),
    eq(subscriptionPaymentAttempts.status, currentStatus),
    currentSignature === null
      ? isNull(subscriptionPaymentAttempts.signature)
      : eq(subscriptionPaymentAttempts.signature, currentSignature)
  ];
  return (await db
    .update(subscriptionPaymentAttempts)
    .set({ status: input.status, updatedAt: now })
    .where(and(...expectedState))
    .returning())[0] ?? null;
}

async function ensureSubscriptionPaymentNotification(
  tx: Database,
  input: {
    workspaceId: string;
    signature: string;
    periodEnd: Date | null;
    now: Date;
    title: string;
  }
) {
  const members = await tx
    .select({ userId: workspaceMemberships.userId })
    .from(workspaceMemberships)
    .where(eq(workspaceMemberships.workspaceId, input.workspaceId));
  if (members.length === 0) return;
  const periodEndLabel = input.periodEnd
    ? input.periodEnd.toISOString().slice(0, 10)
    : "not yet available";
  await tx
    .insert(workspaceNotifications)
    .values(members.map((member) => ({
      workspaceId: input.workspaceId,
      recipientKey: member.userId,
      eventKey: `subscription-payment-confirmed:${input.signature}`,
      category: "Workspace & Billing",
      title: input.title,
      body: `Paylore verified the $49 monthly USDC subscription payment. The current paid period ends on ${periodEndLabel}. Renewal is manual; Paylore will not charge automatically.`,
      destination: `/workspace/${input.workspaceId}/billing`,
      createdAt: input.now
    })))
    .onConflictDoNothing({
      target: [
        workspaceNotifications.workspaceId,
        workspaceNotifications.eventKey,
        workspaceNotifications.recipientKey
      ]
    });
}

export async function applyVerifiedSubscriptionPayment(
  db: Database,
  input: {
    workspaceId: string;
    userId: string;
    signature: string;
    mint: string;
    recipient: string;
    amountBaseUnits: string;
    now?: Date;
  }
) {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    await tx
      .insert(workspaceSubscriptions)
      .values({
        workspaceId: input.workspaceId,
        status: "inactive"
      })
      .onConflictDoNothing({
        target: workspaceSubscriptions.workspaceId
      });

    const currentRows =
      await tx
        .select()
        .from(workspaceSubscriptions)
        .where(
          eq(
            workspaceSubscriptions.workspaceId,
            input.workspaceId
          )
        )
        .for("update")
        .limit(1);

    const current = currentRows[0];
    if (!current) {
      throw new Error(
        "Workspace subscription state could not be locked."
      );
    }

    const hasCurrentPaidPeriod = Boolean(
      current.periodEnd &&
      current.periodEnd > now &&
      (current.status === "active" || current.status === "cancel_scheduled")
    );
    const currentPaymentStart = hasCurrentPaidPeriod ? current.periodEnd! : now;
    const nextPeriodEnd = addCalendarMonth(currentPaymentStart);

    const insertedPayment =
      await tx
        .insert(subscriptionPayments)
        .values({
          workspaceId: input.workspaceId,
          userId: input.userId,
          signature: input.signature,
          mint: input.mint,
          recipient: input.recipient,
          amountBaseUnits: input.amountBaseUnits,
          periodStart: currentPaymentStart,
          periodEnd: nextPeriodEnd,
          verifiedAt: now
        })
        .onConflictDoNothing({
          target: subscriptionPayments.signature
        })
        .returning({
          id: subscriptionPayments.id
        });

    if (!insertedPayment[0]) {
      const priorRows =
        await tx
          .select({
            workspaceId:
              subscriptionPayments.workspaceId,
            userId: subscriptionPayments.userId
          })
          .from(subscriptionPayments)
          .where(
            eq(
              subscriptionPayments.signature,
              input.signature
            )
          )
          .limit(1);
      const prior = priorRows[0];
      if (
        prior?.workspaceId === input.workspaceId &&
        prior.userId === input.userId
      ) {
        await ensureSubscriptionPaymentNotification(tx as unknown as Database, {
          workspaceId: input.workspaceId,
          signature: input.signature,
          periodEnd: current.periodEnd,
          now,
          title: current.status === "active" ? "Workspace active" : "Subscription payment confirmed"
        });
        return {
          duplicate: true,
          periodEnd: current.periodEnd,
          status: current.status
        };
      }
      throw new Error(
        "This payment signature has already been used."
      );
    }

    const updated =
      await tx
        .update(workspaceSubscriptions)
        .set({
          status: "active",
          periodStart: hasCurrentPaidPeriod ? current.periodStart : currentPaymentStart,
          periodEnd: nextPeriodEnd,
          cancelAtPeriodEnd: false,
          updatedAt: now
        })
        .where(
          eq(
            workspaceSubscriptions.workspaceId,
            input.workspaceId
          )
        )
        .returning({
          status: workspaceSubscriptions.status,
          periodStart: workspaceSubscriptions.periodStart,
          periodEnd: workspaceSubscriptions.periodEnd,
          cancelAtPeriodEnd:
            workspaceSubscriptions.cancelAtPeriodEnd
        });

    if (!updated[0]) {
      throw new Error(
        "Verified payment could not activate the workspace."
      );
    }

    await tx
      .update(workspaceRetention)
      .set({ closedAt: null, updatedAt: now })
      .where(eq(workspaceRetention.workspaceId, input.workspaceId));

    await tx
      .insert(workspaceLedgerEntries)
      .values({
        workspaceId: input.workspaceId,
        idempotencyKey: `subscription-payment:${input.signature}`,
        category: "billing",
        entryType: "subscription_payment",
        status: "finalized",
        amountBaseUnits: input.amountBaseUnits,
        mint: input.mint,
        referenceType: "subscription_payment",
        referenceId: input.signature,
        transactionSignature: input.signature,
        metadata: { recipient: input.recipient }
      })
      .onConflictDoNothing({
        target: [
          workspaceLedgerEntries.workspaceId,
          workspaceLedgerEntries.idempotencyKey
        ]
      });

    await ensureSubscriptionPaymentNotification(tx as unknown as Database, {
      workspaceId: input.workspaceId,
      signature: input.signature,
      periodEnd: updated[0].periodEnd,
      now,
      title: current.periodEnd && current.periodEnd > now &&
        (current.status === "active" || current.status === "cancel_scheduled")
        ? "Subscription renewed"
        : "Workspace active"
    });

    return {
      duplicate: false,
      ...updated[0]
    };
  });
}

export async function scheduleSubscriptionCancellation(
  db: Database,
  workspaceId: string,
  now = new Date()
) {
  const current =
    await getWorkspaceSubscription(
      db,
      workspaceId,
      now
    );

  if (
    !current ||
    current.status !== "active" ||
    !current.periodEnd ||
    current.periodEnd <= now
  ) {
    return current;
  }

  const rows =
    await db
      .update(workspaceSubscriptions)
      .set({
        status: "cancel_scheduled",
        cancelAtPeriodEnd: true,
        updatedAt: now
      })
      .where(
        and(
          eq(
            workspaceSubscriptions.workspaceId,
            workspaceId
          ),
          eq(
            workspaceSubscriptions.status,
            "active"
          ),
          gt(
            workspaceSubscriptions.periodEnd,
            now
          )
        )
      )
      .returning();

  return rows[0] ?? current;
}

export async function keepSubscriptionActive(
  db: Database,
  workspaceId: string,
  now = new Date()
) {
  const rows =
    await db
      .update(workspaceSubscriptions)
      .set({
        status: "active",
        cancelAtPeriodEnd: false,
        updatedAt: now
      })
      .where(
        and(
          eq(
            workspaceSubscriptions.workspaceId,
            workspaceId
          ),
          eq(
            workspaceSubscriptions.status,
            "cancel_scheduled"
          ),
          gt(
            workspaceSubscriptions.periodEnd,
            now
          )
        )
      )
      .returning();

  return rows[0] ?? null;
}

export async function listSubscriptionPayments(
  db: Database,
  workspaceId: string
) {
  return db
    .select({
      signature: subscriptionPayments.signature,
      mint: subscriptionPayments.mint,
      amountBaseUnits:
        subscriptionPayments.amountBaseUnits,
      periodStart: subscriptionPayments.periodStart,
      periodEnd: subscriptionPayments.periodEnd,
      verifiedAt: subscriptionPayments.verifiedAt
    })
    .from(subscriptionPayments)
    .where(
      eq(
        subscriptionPayments.workspaceId,
        workspaceId
      )
    )
    .orderBy(
      desc(subscriptionPayments.verifiedAt)
    );
}

export async function listUserNotifications(
  db: Database,
  recipientKey: string,
  limit = 100
) {
  const boundedLimit = Math.min(Math.max(limit, 1), 100);
  const workspaceRows = await db
    .select({
      id: workspaceNotifications.id,
      workspaceId: workspaceNotifications.workspaceId,
      workspaceName: workspaces.name,
      category: workspaceNotifications.category,
      title: workspaceNotifications.title,
      body: workspaceNotifications.body,
      destination: workspaceNotifications.destination,
      readAt: workspaceNotifications.readAt,
      createdAt: workspaceNotifications.createdAt
    })
    .from(workspaceNotifications)
    .innerJoin(
      workspaces,
      eq(workspaces.id, workspaceNotifications.workspaceId)
    )
    .where(eq(workspaceNotifications.recipientKey, recipientKey))
    .orderBy(desc(workspaceNotifications.createdAt), desc(workspaceNotifications.id))
    .limit(boundedLimit);
  const retainedRows = await db
    .select({
      id: userNotifications.id,
      workspaceId: userNotifications.workspaceId,
      workspaceName: userNotifications.workspaceName,
      category: userNotifications.category,
      title: userNotifications.title,
      body: userNotifications.body,
      destination: userNotifications.destination,
      readAt: userNotifications.readAt,
      createdAt: userNotifications.createdAt
    })
    .from(userNotifications)
    .where(eq(userNotifications.recipientKey, recipientKey))
    .orderBy(desc(userNotifications.createdAt), desc(userNotifications.id))
    .limit(boundedLimit);

  return [...workspaceRows, ...retainedRows]
    .sort((left, right) =>
      right.createdAt.getTime() - left.createdAt.getTime() ||
      right.id.localeCompare(left.id)
    )
    .slice(0, boundedLimit);
}

export async function markUserNotificationRead(
  db: Database,
  input: { recipientKey: string; notificationId: string; now?: Date }
) {
  const now = input.now ?? new Date();
  const workspaceRows = await db
    .update(workspaceNotifications)
    .set({ readAt: now })
    .where(
      and(
        eq(workspaceNotifications.id, input.notificationId),
        eq(workspaceNotifications.recipientKey, input.recipientKey),
        isNull(workspaceNotifications.readAt)
      )
    )
    .returning({ id: workspaceNotifications.id });
  if (workspaceRows[0]) return workspaceRows[0];

  const retainedRows = await db
    .update(userNotifications)
    .set({ readAt: now })
    .where(
      and(
        eq(userNotifications.id, input.notificationId),
        eq(userNotifications.recipientKey, input.recipientKey),
        isNull(userNotifications.readAt)
      )
    )
    .returning({ id: userNotifications.id });
  return retainedRows[0] ?? null;
}

export async function markAllUserNotificationsRead(
  db: Database,
  input: { recipientKey: string; now?: Date }
) {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const workspaceRows = await tx
      .update(workspaceNotifications)
      .set({ readAt: now })
      .where(
        and(
          eq(workspaceNotifications.recipientKey, input.recipientKey),
          isNull(workspaceNotifications.readAt)
        )
      )
      .returning({ id: workspaceNotifications.id });
    const retainedRows = await tx
      .update(userNotifications)
      .set({ readAt: now })
      .where(
        and(
          eq(userNotifications.recipientKey, input.recipientKey),
          isNull(userNotifications.readAt)
        )
      )
      .returning({ id: userNotifications.id });
    return workspaceRows.length + retainedRows.length;
  });
}

export async function listWorkspaceContributors(
  db: Database,
  workspaceId: string
) {
  return db
    .select()
    .from(contributors)
    .where(
      eq(contributors.workspaceId, workspaceId)
    )
    .orderBy(asc(contributors.displayName));
}

export async function insertWorkspaceContributors(
  db: Database,
  workspaceId: string,
  rows: Array<{
    displayName: string;
    identityWalletAddress: string;
    effectivePayoutAddress: string;
    role?: "organization_admin" | "finance_auditor" | "contributor";
    organizationLabel?: string | null;
    adminNote?: string | null;
  }>
) {
  if (rows.length === 0) {
    return [];
  }

  return db
    .insert(contributors)
    .values(
      rows.map((row) => ({
        ...row,
        workspaceId,
        role: row.role ?? "contributor",
        lifecycle: "invited" as const,
        onboardingStatus: "pending" as const
      }))
    )
    .returning({
      id: contributors.id,
      displayName: contributors.displayName,
      identityWalletAddress:
        contributors.identityWalletAddress,
      effectivePayoutAddress:
        contributors.effectivePayoutAddress,
      role: contributors.role,
      lifecycle: contributors.lifecycle,
      onboardingStatus:
        contributors.onboardingStatus
    });
}

export async function updateContributorLifecycle(
  db: Database,
  input: {
    workspaceId: string;
    contributorId: string;
    lifecycle: "invited" | "active";
    now?: Date;
  }
) {
  const rows =
    await db
      .update(contributors)
      .set({
        lifecycle: input.lifecycle,
        updatedAt: input.now ?? new Date()
      })
      .where(
        and(
          eq(contributors.id, input.contributorId),
          eq(contributors.workspaceId, input.workspaceId)
        )
      )
      .returning({
        id: contributors.id,
        lifecycle: contributors.lifecycle
      });

  return rows[0] ?? null;
}

export async function updateContributorAdministrativeMetadata(
  db: Database,
  input: {
    workspaceId: string;
    contributorId: string;
    organizationLabel?: string | null;
    adminNote?: string | null;
    now?: Date;
  }
) {
  const changes: {
    organizationLabel?: string | null;
    adminNote?: string | null;
    updatedAt: Date;
  } = { updatedAt: input.now ?? new Date() };
  if (input.organizationLabel !== undefined) changes.organizationLabel = input.organizationLabel;
  if (input.adminNote !== undefined) changes.adminNote = input.adminNote;

  const rows = await db
    .update(contributors)
    .set(changes)
    .where(and(
      eq(contributors.id, input.contributorId),
      eq(contributors.workspaceId, input.workspaceId)
    ))
    .returning({
      id: contributors.id,
      displayName: contributors.displayName,
      identityWalletAddress: contributors.identityWalletAddress,
      effectivePayoutAddress: contributors.effectivePayoutAddress,
      organizationLabel: contributors.organizationLabel,
      adminNote: contributors.adminNote,
      role: contributors.role,
      lifecycle: contributors.lifecycle,
      onboardingStatus: contributors.onboardingStatus
    });
  return rows[0] ?? null;
}

export async function findWorkspaceContributorByWallet(
  db: Database,
  workspaceId: string,
  walletAddress: string
) {
  const rows = await db
    .select({
      id: contributors.id,
      displayName: contributors.displayName,
      identityWalletAddress: contributors.identityWalletAddress,
      lifecycle: contributors.lifecycle,
      role: contributors.role
    })
    .from(contributors)
    .where(
      and(
        eq(contributors.workspaceId, workspaceId),
        eq(contributors.identityWalletAddress, walletAddress),
        eq(contributors.role, "contributor")
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getContributorConfidentialAccount(
  db: Database,
  workspaceId: string,
  contributorId: string
) {
  const rows = await db
    .select({
      ownerWalletAddress:
        contributorConfidentialAccounts.ownerWalletAddress,
      tokenAccountAddress:
        contributorConfidentialAccounts.tokenAccountAddress,
      status: contributorConfidentialAccounts.status,
      setupTransactionSignature:
        contributorConfidentialAccounts.setupTransactionSignature,
      closeTransactionSignature:
        contributorConfidentialAccounts.closeTransactionSignature,
      closedAt: contributorConfidentialAccounts.closedAt
    })
    .from(contributorConfidentialAccounts)
    .where(
      and(
        eq(contributorConfidentialAccounts.workspaceId, workspaceId),
        eq(contributorConfidentialAccounts.contributorId, contributorId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function getCompletedContributorOffboardingByWallet(
  db: Database,
  input: { workspaceId: string; userId: string; walletAddress: string }
) {
  const rows = await db
    .select({
      manualAccountClose: contributorOffboarding.manualAccountClose,
      completedAt: contributorOffboarding.completedAt
    })
    .from(contributorOffboarding)
    .innerJoin(
      contributors,
      and(
        eq(contributors.id, contributorOffboarding.contributorId),
        eq(contributors.workspaceId, contributorOffboarding.workspaceId)
      )
    )
    .innerJoin(
      walletIdentities,
      and(
        eq(walletIdentities.address, contributors.identityWalletAddress),
        eq(walletIdentities.userId, input.userId)
      )
    )
    .where(and(
      eq(contributorOffboarding.workspaceId, input.workspaceId),
      eq(contributors.identityWalletAddress, input.walletAddress),
      eq(contributors.role, "contributor"),
      eq(contributors.lifecycle, "left"),
      eq(contributorOffboarding.status, "completed"),
      isNotNull(contributorOffboarding.associationRemovedAt)
    ))
    .limit(1);
  return rows[0] ?? null;
}

export async function getContributorOffboardingStatus(
  db: Database,
  workspaceId: string,
  contributorId: string
) {
  const rows = await db
    .select({
      requestedAt: contributorOffboarding.requestedAt,
      status: contributorOffboarding.status,
      automaticCleanupEligibleAt:
        contributorOffboarding.automaticCleanupEligibleAt
    })
    .from(contributorOffboarding)
    .where(
      and(
        eq(contributorOffboarding.workspaceId, workspaceId),
        eq(contributorOffboarding.contributorId, contributorId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

export async function requestContributorOffboarding(
  db: Database,
  input: {
    workspaceId: string;
    contributorId: string;
    now?: Date;
  }
): Promise<{
  status: "requested" | "already_requested" | "not_found" | "already_left";
  notificationCreated: boolean;
}> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const matchingContributor = await tx
      .select({
        id: contributors.id,
        identityWalletAddress: contributors.identityWalletAddress,
        lifecycle: contributors.lifecycle
      })
      .from(contributors)
      .where(
        and(
          eq(contributors.id, input.contributorId),
          eq(contributors.workspaceId, input.workspaceId),
          eq(contributors.role, "contributor")
        )
      )
      .for("update")
      .limit(1);
    const contributor = matchingContributor[0];
    if (!contributor) {
      return { status: "not_found", notificationCreated: false };
    }
    if (contributor.lifecycle === "left") {
      return { status: "already_left", notificationCreated: false };
    }

    const inserted = await tx
      .insert(contributorOffboarding)
      .values({
        contributorId: contributor.id,
        workspaceId: input.workspaceId,
        requestedAt: now,
        status: "requested"
      })
      .onConflictDoNothing({
        target: contributorOffboarding.contributorId
      })
      .returning({ contributorId: contributorOffboarding.contributorId });
    if (!inserted[0]) {
      return { status: "already_requested", notificationCreated: false };
    }

    const recipients = await tx
      .select({ userId: walletIdentities.userId })
      .from(walletIdentities)
      .innerJoin(
        workspaceMemberships,
        and(
          eq(workspaceMemberships.userId, walletIdentities.userId),
          eq(workspaceMemberships.workspaceId, input.workspaceId),
          eq(workspaceMemberships.role, "contributor")
        )
      )
      .where(
        eq(walletIdentities.address, contributor.identityWalletAddress)
      )
      .limit(1);
    const notification = recipients[0]
      ? await tx
        .insert(workspaceNotifications)
        .values({
          workspaceId: input.workspaceId,
          recipientKey: recipients[0].userId,
          eventKey: `contributor-offboarding-request:${contributor.id}`,
          category: "Recovery & Offboarding",
          title: "Review your workspace departure",
          body: "Your workspace administrator requested that you review your departure. Resolve any outstanding compensation and pending transactions before choosing Acknowledge & Leave Workspace.",
          destination: `/workspace/${input.workspaceId}/compensation`,
          createdAt: now
        })
        .onConflictDoNothing({
          target: [
            workspaceNotifications.workspaceId,
            workspaceNotifications.eventKey,
            workspaceNotifications.recipientKey
          ]
        })
        .returning({ id: workspaceNotifications.id })
      : [];
    return {
      status: "requested",
      notificationCreated: notification.length > 0
    };
  });
}

export async function hasOpenContributorPayrollAllocations(
  db: Database,
  workspaceId: string,
  contributorId: string
): Promise<boolean> {
  const rows = await db
    .select({ id: payrollAllocations.id })
    .from(payrollAllocations)
    .where(
      and(
        eq(payrollAllocations.workspaceId, workspaceId),
        eq(payrollAllocations.contributorId, contributorId),
        notInArray(payrollAllocations.status, ["claimed", "recovered"])
      )
    )
    .limit(1);
  return rows.length > 0;
}

export async function recordContributorConfidentialAccountSetup(
  db: Database,
  input: {
    workspaceId: string;
    contributorId: string;
    ownerWalletAddress: string;
    tokenAccountAddress: string;
    transactionSignature: string;
    now?: Date;
  }
) {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const activeContributor = await tx
      .select({ id: contributors.id })
      .from(contributors)
      .where(
        and(
          eq(contributors.id, input.contributorId),
          eq(contributors.workspaceId, input.workspaceId),
          eq(contributors.identityWalletAddress, input.ownerWalletAddress),
          eq(contributors.role, "contributor"),
          notInArray(contributors.lifecycle, ["left"])
        )
      )
      .for("update")
      .limit(1);
    if (!activeContributor[0]) {
      throw new Error("CONTRIBUTOR_ACCOUNT_SETUP_NOT_AUTHORIZED");
    }

    const rows = await tx
      .insert(contributorConfidentialAccounts)
      .values({
        workspaceId: input.workspaceId,
        contributorId: input.contributorId,
        ownerWalletAddress: input.ownerWalletAddress,
        tokenAccountAddress: input.tokenAccountAddress,
        status: "ready",
        setupTransactionSignature: input.transactionSignature,
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: contributorConfidentialAccounts.contributorId,
        set: {
          ownerWalletAddress: input.ownerWalletAddress,
          tokenAccountAddress: input.tokenAccountAddress,
          status: "ready",
          setupTransactionSignature: input.transactionSignature,
          closeTransactionSignature: null,
          closedAt: null,
          updatedAt: now
        }
      })
      .returning({
        contributorId: contributorConfidentialAccounts.contributorId,
        tokenAccountAddress:
          contributorConfidentialAccounts.tokenAccountAddress,
        status: contributorConfidentialAccounts.status,
        setupTransactionSignature:
          contributorConfidentialAccounts.setupTransactionSignature
      });
    return rows[0];
  });
}

export async function completeContributorOffboarding(
  db: Database,
  input: {
    workspaceId: string;
    contributorId: string;
    userId: string;
    walletAddress: string;
    closeTransactionSignature: string | null;
    now?: Date;
  }
): Promise<"completed" | "already_completed" | "outstanding_obligations" | "not_found"> {
  const now = input.now ?? new Date();
  const disposition = getContributorDepartureDisposition(Boolean(input.closeTransactionSignature));
  return db.transaction(async (tx) => {
    const matchingContributor = await tx
      .select({
        id: contributors.id,
        displayName: contributors.displayName,
        lifecycle: contributors.lifecycle
      })
      .from(contributors)
      .where(
        and(
          eq(contributors.id, input.contributorId),
          eq(contributors.workspaceId, input.workspaceId),
          eq(contributors.identityWalletAddress, input.walletAddress),
          eq(contributors.role, "contributor")
        )
      )
      .for("update")
      .limit(1);
    const matchedContributor = matchingContributor[0];
    if (!matchedContributor) return "not_found";
    if (matchedContributor.lifecycle === "left") {
      const completedRows = await tx
        .select({
          status: contributorOffboarding.status,
          associationRemovedAt: contributorOffboarding.associationRemovedAt
        })
        .from(contributorOffboarding)
        .where(and(
          eq(contributorOffboarding.workspaceId, input.workspaceId),
          eq(contributorOffboarding.contributorId, input.contributorId)
        ))
        .limit(1);
      return completedRows[0]?.status === "completed" && completedRows[0].associationRemovedAt
        ? "already_completed"
        : "not_found";
    }

    const openAllocations = await tx
      .select({ id: payrollAllocations.id })
      .from(payrollAllocations)
      .where(
        and(
          eq(payrollAllocations.workspaceId, input.workspaceId),
          eq(payrollAllocations.contributorId, input.contributorId),
          notInArray(payrollAllocations.status, ["claimed", "recovered"])
        )
      )
      .limit(1);
    if (openAllocations.length > 0) return "outstanding_obligations";

    const account = await tx
      .select({ status: contributorConfidentialAccounts.status })
      .from(contributorConfidentialAccounts)
      .where(
        and(
          eq(contributorConfidentialAccounts.workspaceId, input.workspaceId),
          eq(contributorConfidentialAccounts.contributorId, input.contributorId)
        )
      )
      .limit(1);
    if (
      account[0]?.status === "ready" &&
      !input.closeTransactionSignature
    ) {
      return "not_found";
    }

    await tx
      .update(contributors)
      .set({ lifecycle: "left", updatedAt: now })
      .where(
        and(
          eq(contributors.id, input.contributorId),
          eq(contributors.workspaceId, input.workspaceId)
        )
      );

    await tx
      .insert(contributorOffboarding)
      .values({
        contributorId: input.contributorId,
        workspaceId: input.workspaceId,
        completedAt: now,
        manualAccountClose: disposition.manualAccountClose,
        closeTransactionSignature: input.closeTransactionSignature,
        associationRemovedAt: now,
        status: "completed"
      })
      .onConflictDoUpdate({
        target: contributorOffboarding.contributorId,
        set: {
          completedAt: now,
          manualAccountClose: disposition.manualAccountClose,
          closeTransactionSignature: input.closeTransactionSignature,
          automaticCleanupEligibleAt: null,
          associationRemovedAt: now,
          status: "completed"
        }
      });

    if (input.closeTransactionSignature) {
      await tx
        .update(contributorConfidentialAccounts)
        .set({
          status: "closed",
          closeTransactionSignature: input.closeTransactionSignature,
          closedAt: now,
          updatedAt: now
        })
        .where(
          and(
            eq(contributorConfidentialAccounts.workspaceId, input.workspaceId),
            eq(contributorConfidentialAccounts.contributorId, input.contributorId)
          )
        );
    }

    await tx
      .delete(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, input.workspaceId),
          eq(workspaceMemberships.userId, input.userId),
          eq(workspaceMemberships.role, "contributor")
        )
      );
    await tx
      .insert(workspaceLedgerEntries)
      .values({
      workspaceId: input.workspaceId,
      idempotencyKey: `contributor-offboarding:${input.contributorId}`,
      category: "recovery",
      entryType: "contributor_offboarding",
      status: "finalized",
      referenceType: "contributor_offboarding",
      referenceId: input.contributorId,
      transactionSignature: input.closeTransactionSignature,
      metadata: {
        manualAccountClose: disposition.manualAccountClose,
        departureMode: disposition.departureMode
      },
      createdAt: now
      })
      .onConflictDoNothing({
      target: [
        workspaceLedgerEntries.workspaceId,
        workspaceLedgerEntries.idempotencyKey
      ]
      });
    await tx
      .insert(workspaceNotifications)
      .values({
        workspaceId: input.workspaceId,
        recipientKey: input.userId,
        eventKey: `contributor-offboarding-completed:${input.contributorId}`,
        category: "Recovery & Offboarding",
        title: "You have left the workspace",
        body: disposition.notificationBody,
        destination: "/notifications",
        createdAt: now
      })
      .onConflictDoNothing({
        target: [
          workspaceNotifications.workspaceId,
          workspaceNotifications.eventKey,
          workspaceNotifications.recipientKey
        ]
      });

    const adminMembers = await tx
      .select({ userId: workspaceMemberships.userId })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, input.workspaceId),
          eq(workspaceMemberships.role, "organization_admin")
        )
      );
    if (adminMembers.length > 0) {
      const accountOutcome = disposition.manualAccountClose
        ? `${matchedContributor.displayName} left the workspace and confidential-account closure was recorded.`
        : `${matchedContributor.displayName} left the workspace without closing their confidential account. The account remains under the contributor's control.`;
      await tx
        .insert(workspaceNotifications)
        .values(
          adminMembers.map((member) => ({
            workspaceId: input.workspaceId,
            recipientKey: member.userId,
            eventKey: `contributor-offboarding-completed:${input.contributorId}`,
            category: "Recovery & Offboarding",
            title: "Contributor departure completed",
            body: accountOutcome,
            destination: `/workspace/${input.workspaceId}/contributors`,
            createdAt: now
          }))
        )
        .onConflictDoNothing({
          target: [
            workspaceNotifications.workspaceId,
            workspaceNotifications.eventKey,
            workspaceNotifications.recipientKey
          ]
        });
    }
    return "completed";
  });
}

export async function cleanupEligibleContributorAssociations(
  db: Database,
  now: Date,
  limit = 100
): Promise<{ removed: number; deferred: number }> {
  const eligibilityCutoff = new Date(
    now.getTime() - CONTRIBUTOR_ASSOCIATION_CLEANUP_DELAY_MS
  );
  const candidates = await db
    .select({
      contributorId: contributors.id,
      workspaceId: contributors.workspaceId
    })
    .from(contributors)
    .innerJoin(
      workspaceRetention,
      eq(workspaceRetention.workspaceId, contributors.workspaceId)
    )
    .where(
      and(
        eq(contributors.role, "contributor"),
        notInArray(contributors.lifecycle, ["left"]),
        lte(workspaceRetention.closedAt, eligibilityCutoff)
      )
    )
    .orderBy(asc(workspaceRetention.closedAt), asc(contributors.id))
    .limit(Math.min(Math.max(limit, 1), 500));

  let removed = 0;
  let deferred = 0;
  for (const candidate of candidates) {
    const result = await db.transaction(async (tx) => {
      const lockedContributor = await tx
        .select({
          id: contributors.id,
          displayName: contributors.displayName,
          identityWalletAddress: contributors.identityWalletAddress,
          lifecycle: contributors.lifecycle
        })
        .from(contributors)
        .where(
          and(
            eq(contributors.id, candidate.contributorId),
            eq(contributors.workspaceId, candidate.workspaceId),
            eq(contributors.role, "contributor"),
            notInArray(contributors.lifecycle, ["left"])
          )
        )
        .for("update")
        .limit(1);
      const contributor = lockedContributor[0];
      if (!contributor) return "unchanged" as const;

      const retentionRows = await tx
        .select({ closedAt: workspaceRetention.closedAt })
        .from(workspaceRetention)
        .where(eq(workspaceRetention.workspaceId, candidate.workspaceId))
        .for("update")
        .limit(1);
      const closedAt = retentionRows[0]?.closedAt ?? null;
      if (!closedAt) return "unchanged" as const;
      if (
        !isContributorAssociationCleanupEligible({
          workspaceClosedAt: closedAt,
          outstandingObligations: false,
          now
        })
      ) {
        return "unchanged" as const;
      }

      const openAllocations = await tx
        .select({ id: payrollAllocations.id })
        .from(payrollAllocations)
        .where(
          and(
            eq(payrollAllocations.workspaceId, candidate.workspaceId),
            eq(payrollAllocations.contributorId, candidate.contributorId),
            notInArray(payrollAllocations.status, ["claimed", "recovered"])
          )
        )
        .limit(1);
      const eligibleAt = new Date(
        closedAt.getTime() + CONTRIBUTOR_ASSOCIATION_CLEANUP_DELAY_MS
      );
      const adminRecipients = await tx
        .select({ userId: workspaceMemberships.userId })
        .from(workspaceMemberships)
        .where(
          and(
            eq(workspaceMemberships.workspaceId, candidate.workspaceId),
            eq(workspaceMemberships.role, "organization_admin")
          )
        );
      if (openAllocations.length > 0) {
        if (adminRecipients.length > 0) {
          await tx
            .insert(workspaceNotifications)
            .values(
              adminRecipients.map((member) => ({
                workspaceId: candidate.workspaceId,
                recipientKey: member.userId,
                eventKey: `contributor-association-cleanup-deferred:${contributor.id}:${eligibleAt.getTime()}`,
                category: "Recovery & Offboarding",
                title: "Contributor association cleanup deferred",
                body: `Cleanup for ${contributor.displayName}'s workspace association was deferred because qualifying compensation obligations remain. Resolve them before removing the association.`,
                destination: `/workspace/${candidate.workspaceId}/contributors`,
                createdAt: now
              }))
            )
            .onConflictDoNothing({
              target: [
                workspaceNotifications.workspaceId,
                workspaceNotifications.eventKey,
                workspaceNotifications.recipientKey
              ]
            });
        }
        const affectedRecipients = await tx
          .select({ userId: walletIdentities.userId })
          .from(walletIdentities)
          .innerJoin(
            workspaceMemberships,
            and(
              eq(workspaceMemberships.userId, walletIdentities.userId),
              eq(workspaceMemberships.workspaceId, candidate.workspaceId),
              eq(workspaceMemberships.role, "contributor")
            )
          )
          .where(eq(walletIdentities.address, contributor.identityWalletAddress))
          .limit(1);
        if (affectedRecipients[0]) {
          await tx
            .insert(workspaceNotifications)
            .values({
              workspaceId: candidate.workspaceId,
              recipientKey: affectedRecipients[0].userId,
              eventKey: `contributor-association-cleanup-deferred:${contributor.id}:${eligibleAt.getTime()}`,
              category: "Recovery & Offboarding",
              title: "Workspace association cleanup delayed",
              body: "Your workspace association remains active while qualifying compensation obligations are unresolved. Your confidential account has not been closed or changed.",
              destination: "/notifications",
              createdAt: now
            })
            .onConflictDoNothing({
              target: [
                workspaceNotifications.workspaceId,
                workspaceNotifications.eventKey,
                workspaceNotifications.recipientKey
              ]
            });
        }
        await tx
          .insert(contributorOffboarding)
          .values({
            contributorId: contributor.id,
            workspaceId: candidate.workspaceId,
            manualAccountClose: false,
            automaticCleanupEligibleAt: eligibleAt,
            status: "deferred_obligations"
          })
          .onConflictDoUpdate({
            target: contributorOffboarding.contributorId,
            set: {
              automaticCleanupEligibleAt: eligibleAt,
              status: "deferred_obligations"
            }
          });
        return "deferred" as const;
      }

      const recipients = await tx
        .select({ userId: walletIdentities.userId })
        .from(walletIdentities)
        .innerJoin(
          workspaceMemberships,
          and(
            eq(workspaceMemberships.userId, walletIdentities.userId),
            eq(workspaceMemberships.workspaceId, candidate.workspaceId),
            eq(workspaceMemberships.role, "contributor")
          )
        )
        .where(
          eq(walletIdentities.address, contributor.identityWalletAddress)
        )
        .limit(1);
      const recipient = recipients[0]?.userId;
      const disposition = getAutomaticContributorCleanupDisposition();
      if (recipient) {
        await tx
          .insert(workspaceNotifications)
          .values({
            workspaceId: candidate.workspaceId,
            recipientKey: recipient,
            eventKey: `contributor-association-cleanup:${contributor.id}`,
            category: "Recovery & Offboarding",
            title: "Workspace association removed",
            body: disposition.notificationBody,
            destination: "/",
            createdAt: now
          })
          .onConflictDoNothing({
            target: [
              workspaceNotifications.workspaceId,
              workspaceNotifications.eventKey,
              workspaceNotifications.recipientKey
            ]
          });
      }
      if (adminRecipients.length > 0) {
        await tx
          .insert(workspaceNotifications)
          .values(
            adminRecipients.map((member) => ({
              workspaceId: candidate.workspaceId,
              recipientKey: member.userId,
              eventKey: `contributor-association-cleanup:${contributor.id}`,
              category: "Recovery & Offboarding",
              title: "Contributor workspace association removed",
              body: `${contributor.displayName}'s workspace application association was removed after the retention period. Their confidential account and on-chain state were not closed or deleted by Paylore.`,
              destination: `/workspace/${candidate.workspaceId}/contributors`,
              createdAt: now
            }))
          )
          .onConflictDoNothing({
            target: [
              workspaceNotifications.workspaceId,
              workspaceNotifications.eventKey,
              workspaceNotifications.recipientKey
            ]
          });
      }

      await tx
        .insert(contributorOffboarding)
        .values({
          contributorId: contributor.id,
          workspaceId: candidate.workspaceId,
          completedAt: now,
          manualAccountClose: disposition.manualAccountClose,
          closeTransactionSignature: null,
          automaticCleanupEligibleAt: eligibleAt,
          associationRemovedAt: now,
          status: "completed"
        })
        .onConflictDoUpdate({
          target: contributorOffboarding.contributorId,
          set: {
            completedAt: now,
            manualAccountClose: disposition.manualAccountClose,
            closeTransactionSignature: null,
            automaticCleanupEligibleAt: eligibleAt,
            associationRemovedAt: now,
            status: "completed"
          }
        });
      await tx
        .insert(workspaceLedgerEntries)
        .values({
          workspaceId: candidate.workspaceId,
          idempotencyKey: `contributor-association-cleanup:${contributor.id}`,
          category: "recovery",
          entryType: "contributor_association_cleanup",
          status: "finalized",
          referenceType: "contributor_offboarding",
          referenceId: contributor.id,
          metadata: {
            manualAccountClose: disposition.manualAccountClose,
            departureMode: disposition.departureMode
          },
          createdAt: now
        })
        .onConflictDoNothing({
          target: [
            workspaceLedgerEntries.workspaceId,
            workspaceLedgerEntries.idempotencyKey
          ]
        });
      await tx
        .update(contributors)
        .set({ lifecycle: "left", updatedAt: now })
        .where(eq(contributors.id, contributor.id));
      if (recipient) {
        await tx
          .delete(workspaceMemberships)
          .where(
            and(
              eq(workspaceMemberships.workspaceId, candidate.workspaceId),
              eq(workspaceMemberships.userId, recipient),
              eq(workspaceMemberships.role, "contributor")
            )
          );
      }
      return "removed" as const;
    });
    if (result === "removed") removed += 1;
    if (result === "deferred") deferred += 1;
  }
  return { removed, deferred };
}

export async function createContributorInvitation(
  db: Database,
  input: {
    tokenHash: string;
    workspaceId: string;
    contributorId: string;
    createdByUserId: string;
    expiresAt: Date;
    now?: Date;
  }
) {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const contributorRows =
      await tx
        .select({
          walletAddress:
            contributors.identityWalletAddress,
          lifecycle: contributors.lifecycle,
          role: contributors.role
        })
        .from(contributors)
        .where(
          and(
            eq(contributors.id, input.contributorId),
            eq(contributors.workspaceId, input.workspaceId)
          )
        )
        .limit(1);

    const contributor = contributorRows[0];
    if (!contributor || contributor.lifecycle === "left" || contributor.role === "organization_admin") {
      throw new Error("Contributor is not eligible for an invitation.");
    }

    const [invitation] =
      await tx
        .insert(contributorInvitations)
        .values({
          tokenHash: input.tokenHash,
          workspaceId: input.workspaceId,
          contributorId: input.contributorId,
          createdByUserId: input.createdByUserId,
          expiresAt: input.expiresAt
        })
        .returning({
          id: contributorInvitations.id
        });

    await tx
      .insert(invitationEntryTargets)
      .values({
        tokenHash: input.tokenHash,
        workspaceId: input.workspaceId,
        contributorWalletAddress:
          contributor.walletAddress,
        expiresAt: input.expiresAt,
        createdAt: now
      });

    return invitation;
  });
}

export async function listWorkspaceInvitations(
  db: Database,
  workspaceId: string,
  now = new Date()
) {
  return db
    .select({
      id: contributorInvitations.id,
      contributorId:
        contributorInvitations.contributorId,
      contributorName: contributors.displayName,
      contributorRole: contributors.role,
      status: contributors.lifecycle,
      expiresAt: contributorInvitations.expiresAt,
      acceptedAt: contributorInvitations.acceptedAt
    })
    .from(contributorInvitations)
    .innerJoin(
      contributors,
      eq(
        contributorInvitations.contributorId,
        contributors.id
      )
    )
    .where(
      and(
        eq(contributorInvitations.workspaceId, workspaceId),
        gt(contributorInvitations.expiresAt, now)
      )
    )
    .orderBy(
      desc(contributorInvitations.createdAt)
    );
}

export async function acceptContributorInvitation(
  db: Database,
  input: {
    tokenHash: string;
    userId: string;
    walletAddress: string;
    now?: Date;
  }
) {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const rows =
      await tx
        .select({
          id: contributorInvitations.id,
          workspaceId: contributorInvitations.workspaceId,
          contributorId:
            contributorInvitations.contributorId,
          acceptedAt: contributorInvitations.acceptedAt,
          expiresAt: contributorInvitations.expiresAt,
          identityWalletAddress:
            contributors.identityWalletAddress,
          contributorRole: contributors.role,
          lifecycle: contributors.lifecycle
        })
        .from(contributorInvitations)
        .innerJoin(
          contributors,
          eq(
            contributorInvitations.contributorId,
            contributors.id
          )
        )
        .where(
          eq(
            contributorInvitations.tokenHash,
            input.tokenHash
          )
        )
        .for("update")
        .limit(1);

    const invitation = rows[0];
    if (
      !invitation ||
      invitation.expiresAt <= now ||
      invitation.acceptedAt ||
      invitation.lifecycle === "left"
    ) {
      return null;
    }
    if (invitation.contributorRole === "organization_admin") {
      return null;
    }
    if (
      invitation.identityWalletAddress !==
      input.walletAddress
    ) {
      throw new Error(
        "The authenticated wallet does not match this invitation."
      );
    }

    const accepted =
      await tx
        .update(contributorInvitations)
        .set({ acceptedAt: now })
        .where(
          and(
            eq(
              contributorInvitations.id,
              invitation.id
            ),
            isNull(contributorInvitations.acceptedAt),
            gt(contributorInvitations.expiresAt, now)
          )
        )
        .returning({
          id: contributorInvitations.id
        });

    if (!accepted[0]) {
      return null;
    }

    const membership =
      await tx
        .insert(workspaceMemberships)
        .values({
          workspaceId: invitation.workspaceId,
          userId: input.userId,
          role: invitation.contributorRole
        })
        .onConflictDoNothing({
          target: [
            workspaceMemberships.workspaceId,
            workspaceMemberships.userId
          ]
        })
        .returning({
          role: workspaceMemberships.role
        });

    if (!membership[0]) {
      const existingMembership =
        await tx
          .select({
            role: workspaceMemberships.role
          })
          .from(workspaceMemberships)
          .where(
            and(
              eq(
                workspaceMemberships.workspaceId,
                invitation.workspaceId
              ),
              eq(
                workspaceMemberships.userId,
                input.userId
              )
            )
          )
          .limit(1);
      if (
        existingMembership[0]?.role !==
        invitation.contributorRole
      ) {
        throw new Error(
          "This wallet already has a different workspace role."
        );
      }
    }

    await tx
      .update(contributors)
      .set({
        lifecycle: "active",
        onboardingStatus: "complete",
        updatedAt: now
      })
      .where(and(
        eq(contributors.id, invitation.contributorId),
        eq(contributors.workspaceId, invitation.workspaceId)
      ));

    return {
      workspaceId: invitation.workspaceId,
      contributorId: invitation.contributorId,
      role: invitation.contributorRole
    };
  });
}

export async function getWorkspaceReserve(
  db: Database,
  workspaceId: string
) {
  const rows =
    await db
      .select()
      .from(workspaceReserves)
      .where(
        eq(workspaceReserves.workspaceId, workspaceId)
      )
      .limit(1);

  return rows[0] ?? null;
}

export type WorkspaceReserveSetupPhase = "account_setup" | "program_configure";

export async function attachWorkspaceReserveSetupSignature(
  db: Database,
  input: { workspaceId: string; phase: WorkspaceReserveSetupPhase; signature: string }
): Promise<"attached" | "duplicate" | "conflict" | "not_found"> {
  if (!input.signature || input.signature.length > 128) return "conflict";
  return db.transaction(async (tx) => {
    const rows = await tx.select({
      accountSignature: workspaceReserves.confidentialAccountSetupSignature,
      programSignature: workspaceReserves.programReserveSetupSignature
    }).from(workspaceReserves)
      .where(eq(workspaceReserves.workspaceId, input.workspaceId))
      .for("update").limit(1);
    const current = rows[0];
    if (!current) return "not_found";
    const existing = input.phase === "account_setup"
      ? current.accountSignature : current.programSignature;
    if (existing === input.signature) return "duplicate";
    if (existing !== null) return "conflict";

    const updated = input.phase === "account_setup"
      ? await tx.update(workspaceReserves).set({
          confidentialAccountSetupSignature: input.signature,
          updatedAt: new Date()
        }).where(and(
          eq(workspaceReserves.workspaceId, input.workspaceId),
          isNull(workspaceReserves.confidentialAccountSetupSignature)
        )).returning({ workspaceId: workspaceReserves.workspaceId })
      : await tx.update(workspaceReserves).set({
          programReserveSetupSignature: input.signature,
          updatedAt: new Date()
        }).where(and(
          eq(workspaceReserves.workspaceId, input.workspaceId),
          isNull(workspaceReserves.programReserveSetupSignature)
        )).returning({ workspaceId: workspaceReserves.workspaceId });
    return updated[0] ? "attached" : "conflict";
  });
}

export async function clearWorkspaceReserveSetupSignature(
  db: Database,
  input: { workspaceId: string; phase: WorkspaceReserveSetupPhase; signature: string }
): Promise<boolean> {
  const updated = input.phase === "account_setup"
    ? await db.update(workspaceReserves).set({
        confidentialAccountSetupSignature: null,
        updatedAt: new Date()
      }).where(and(
        eq(workspaceReserves.workspaceId, input.workspaceId),
        eq(workspaceReserves.confidentialAccountSetupSignature, input.signature)
      )).returning({ workspaceId: workspaceReserves.workspaceId })
    : await db.update(workspaceReserves).set({
        programReserveSetupSignature: null,
        updatedAt: new Date()
      }).where(and(
        eq(workspaceReserves.workspaceId, input.workspaceId),
        eq(workspaceReserves.programReserveSetupSignature, input.signature)
      )).returning({ workspaceId: workspaceReserves.workspaceId });
  return Boolean(updated[0]);
}

export async function createWorkspaceReserve(
  db: Database,
  input: typeof workspaceReserves.$inferInsert
) {
  return db.transaction(async (tx) => {
    const deletion = await tx
      .select({
        deletionScheduledAt: workspaceRetention.deletionScheduledAt,
        deletionCanceledAt: workspaceRetention.deletionCanceledAt
      })
      .from(workspaceRetention)
      .where(eq(workspaceRetention.workspaceId, input.workspaceId))
      .for("update")
      .limit(1);
    if (
      deletion[0]?.deletionScheduledAt &&
      !deletion[0].deletionCanceledAt
    ) {
      throw new Error("WORKSPACE_DELETION_PENDING");
    }

    const rows = await tx
      .insert(workspaceReserves)
      .values(input)
      .onConflictDoNothing({
        target: workspaceReserves.workspaceId
      })
      .returning();
    if (rows[0]) return { reserve: rows[0], created: true };

    const existing = await tx
      .select()
      .from(workspaceReserves)
      .where(eq(workspaceReserves.workspaceId, input.workspaceId))
      .limit(1);
    if (!existing[0]) {
      throw new Error(
        "Workspace reserve could not be created or retrieved."
      );
    }
    return { reserve: existing[0], created: false };
  });
}

export async function restoreWorkspaceReserve(
  db: Database,
  workspaceId: string,
  sealedFields: Pick<
    typeof workspaceReserves.$inferInsert,
    | "address"
    | "encryptedPrivateKey"
    | "privateKeyNonce"
    | "privateKeyAuthTag"
    | "encryptedDataKey"
    | "dataKeyNonce"
    | "dataKeyAuthTag"
    | "encryptedBackup"
    | "backupNonce"
    | "backupAuthTag"
  >,
  now = new Date()
) {
  const rows =
    await db
      .update(workspaceReserves)
      .set({
        ...sealedFields,
        updatedAt: now
      })
      .where(
        eq(workspaceReserves.workspaceId, workspaceId)
      )
      .returning({
        workspaceId: workspaceReserves.workspaceId,
        address: workspaceReserves.address
      });

  return rows[0] ?? null;
}


export async function getWorkspaceGasTank(
  db: Database,
  workspaceId: string
) {
  const rows = await db
    .select()
    .from(workspaceGasTanks)
    .where(eq(workspaceGasTanks.workspaceId, workspaceId))
    .limit(1);

  return rows[0] ?? null;
}

export async function createWorkspaceGasTank(
  db: Database,
  input: typeof workspaceGasTanks.$inferInsert
) {
  return db.transaction(async (tx) => {
    const deletion = await tx
      .select({
        deletionScheduledAt: workspaceRetention.deletionScheduledAt,
        deletionCanceledAt: workspaceRetention.deletionCanceledAt
      })
      .from(workspaceRetention)
      .where(eq(workspaceRetention.workspaceId, input.workspaceId))
      .for("update")
      .limit(1);
    if (
      deletion[0]?.deletionScheduledAt &&
      !deletion[0].deletionCanceledAt
    ) {
      throw new Error("WORKSPACE_DELETION_PENDING");
    }

    const rows = await tx
      .insert(workspaceGasTanks)
      .values(input)
      .onConflictDoNothing({
        target: workspaceGasTanks.workspaceId
      })
      .returning();
    if (rows[0]) return { gasTank: rows[0], created: true };

    const existing = await tx
      .select()
      .from(workspaceGasTanks)
      .where(eq(workspaceGasTanks.workspaceId, input.workspaceId))
      .limit(1);
    if (!existing[0]) {
      throw new Error("Workspace Gas Tank could not be created or retrieved.");
    }
    return { gasTank: existing[0], created: false };
  });
}

export async function updateWorkspaceGasTankBalance(
  db: Database,
  workspaceId: string,
  balanceLamports: string,
  now = new Date()
) {
  const rows = await db
    .update(workspaceGasTanks)
    .set({
      balanceLamports,
      lastActivityAt: now,
      updatedAt: now
    })
    .where(eq(workspaceGasTanks.workspaceId, workspaceId))
    .returning({
      workspaceId: workspaceGasTanks.workspaceId,
      address: workspaceGasTanks.address,
      balanceLamports: workspaceGasTanks.balanceLamports,
      lastActivityAt: workspaceGasTanks.lastActivityAt,
      updatedAt: workspaceGasTanks.updatedAt
    });
  return rows[0] ?? null;
}

export async function restoreWorkspaceGasTank(
  db: Database,
  workspaceId: string,
  sealedFields: Pick<
    typeof workspaceGasTanks.$inferInsert,
    | "address"
    | "encryptedPrivateKey"
    | "privateKeyNonce"
    | "privateKeyAuthTag"
    | "encryptedDataKey"
    | "dataKeyNonce"
    | "dataKeyAuthTag"
    | "encryptedBackup"
    | "backupNonce"
    | "backupAuthTag"
  >,
  now = new Date()
) {
  const rows = await db
    .update(workspaceGasTanks)
    .set({
      ...sealedFields,
      updatedAt: now
    })
    .where(eq(workspaceGasTanks.workspaceId, workspaceId))
    .returning({
      workspaceId: workspaceGasTanks.workspaceId,
      address: workspaceGasTanks.address
    });
  return rows[0] ?? null;
}

export async function createWorkspaceLedgerEntry(
  db: Database,
  input: typeof workspaceLedgerEntries.$inferInsert
) {
  const rows = await db
    .insert(workspaceLedgerEntries)
    .values(input)
    .onConflictDoNothing({
      target: [
        workspaceLedgerEntries.workspaceId,
        workspaceLedgerEntries.idempotencyKey
      ]
    })
    .returning();

  if (rows[0]) return { entry: rows[0], created: true };
  const existing = await db
    .select()
    .from(workspaceLedgerEntries)
    .where(
      and(
        eq(workspaceLedgerEntries.workspaceId, input.workspaceId),
        eq(workspaceLedgerEntries.idempotencyKey, input.idempotencyKey)
      )
    )
    .limit(1);
  if (!existing[0]) {
    throw new Error("The workspace ledger entry could not be retrieved.");
  }
  return { entry: existing[0], created: false };
}

export async function listFinalizedLedgerWorkspaceIdsForSignature(
  db: Database,
  signature: string
) {
  return db
    .selectDistinct({ workspaceId: workspaceLedgerEntries.workspaceId })
    .from(workspaceLedgerEntries)
    .where(and(
      eq(workspaceLedgerEntries.transactionSignature, signature),
      eq(workspaceLedgerEntries.status, "finalized")
    ));
}

export async function listHeliusMonitoredAddresses(db: Database): Promise<string[]> {
  const [
    reserves,
    gasTanks,
    contributorAccounts,
    claimAccounts
  ] = await Promise.all([
    db.select({ address: workspaceReserves.address }).from(workspaceReserves),
    db.select({ address: workspaceGasTanks.address }).from(workspaceGasTanks),
    db
      .select({ address: contributorConfidentialAccounts.tokenAccountAddress })
      .from(contributorConfidentialAccounts)
      .where(isNull(contributorConfidentialAccounts.closedAt)),
    db
      .select({ address: payrollAllocations.claimAddress })
      .from(payrollAllocations)
      .where(isNotNull(payrollAllocations.claimAddress))
  ]);

  // These are application-owned custody and entitlement accounts. Identity wallets
  // are intentionally excluded; the monitored set must not become a contributor list.
  return [
    ...new Set(
      [
        ...reserves.map((row) => row.address),
        ...gasTanks.map((row) => row.address),
        ...contributorAccounts.map((row) => row.address),
        ...claimAccounts.map((row) => row.address)
      ].filter((value): value is string => typeof value === "string" && value.length > 0)
    )
  ].sort();
}

export async function persistSolanaWebhookEvents(
  db: Database,
  events: Array<typeof solanaWebhookEvents.$inferInsert>
) {
  if (events.length === 0) {
    return { inserted: 0, duplicates: 0 };
  }
  const inserted = await db
    .insert(solanaWebhookEvents)
    .values(events)
    .onConflictDoNothing({
      target: [
        solanaWebhookEvents.provider,
        solanaWebhookEvents.providerEventId
      ]
    })
    .returning({ id: solanaWebhookEvents.id });
  return {
    inserted: inserted.length,
    duplicates: events.length - inserted.length
  };
}

export async function getCanonicalReconciliationCursor(db: Database, address: string) {
  const rows = await db.select().from(solanaReconciliationCursors)
    .where(eq(solanaReconciliationCursors.address, address)).limit(1);
  return rows[0] ?? null;
}

export async function listCanonicalReconciliationCursors(db: Database) {
  return db.select().from(solanaReconciliationCursors);
}

/** Stores discovered events and the cursor in one transaction so a failed insert cannot skip a chain range. */
export async function persistCanonicalReconciliationScanPage(
  db: Database,
  input: {
    address: string;
    highWaterSignature: string | null;
    backfillBeforeSignature: string | null;
    backfillUntilSignature: string | null;
    events: Array<typeof solanaWebhookEvents.$inferInsert>;
    now?: Date;
  }
): Promise<{ inserted: number; duplicates: number }> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const inserted = input.events.length
      ? await tx.insert(solanaWebhookEvents).values(input.events)
          .onConflictDoNothing({
            target: [solanaWebhookEvents.provider, solanaWebhookEvents.providerEventId]
          }).returning({ id: solanaWebhookEvents.id })
      : [];
    await tx.insert(solanaReconciliationCursors).values({
      address: input.address,
      highWaterSignature: input.highWaterSignature,
      backfillBeforeSignature: input.backfillBeforeSignature,
      backfillUntilSignature: input.backfillUntilSignature,
      updatedAt: now
    }).onConflictDoUpdate({
      target: solanaReconciliationCursors.address,
      set: {
        highWaterSignature: input.highWaterSignature,
        backfillBeforeSignature: input.backfillBeforeSignature,
        backfillUntilSignature: input.backfillUntilSignature,
        updatedAt: now
      }
    });
    return { inserted: inserted.length, duplicates: input.events.length - inserted.length };
  });
}

export async function claimDueSolanaWebhookEvents(
  db: Database,
  input: {
    now?: Date;
    limit?: number;
    leaseMilliseconds?: number;
  } = {}
) {
  const now = input.now ?? new Date();
  const limit = Math.min(Math.max(input.limit ?? 5, 1), 10);
  const leaseUntil = new Date(
    now.getTime() + (input.leaseMilliseconds ?? 60_000)
  );
  return db.transaction(async (tx) => {
    const dueEvents = await tx
      .select({
        id: solanaWebhookEvents.id,
        transactionSignature:
          solanaWebhookEvents.transactionSignature,
        transactionSlot: solanaWebhookEvents.transactionSlot
      })
      .from(solanaWebhookEvents)
      .where(
        or(
          eq(solanaWebhookEvents.status, "received"),
          and(
            eq(solanaWebhookEvents.status, "retry_pending"),
            or(
              isNull(solanaWebhookEvents.nextAttemptAt),
              lte(solanaWebhookEvents.nextAttemptAt, now)
            )
          ),
          and(
            eq(solanaWebhookEvents.status, "processing"),
            lte(solanaWebhookEvents.nextAttemptAt, now)
          )
        )
      )
      .orderBy(asc(solanaWebhookEvents.receivedAt))
      .for("update", { skipLocked: true })
      .limit(limit);
    if (dueEvents.length === 0) return [];

    return tx
      .update(solanaWebhookEvents)
      .set({
        status: "processing",
        attempts: sql`${solanaWebhookEvents.attempts} + 1`,
        nextAttemptAt: leaseUntil
      })
      .where(
        inArray(
          solanaWebhookEvents.id,
          dueEvents.map((event) => event.id)
        )
      )
      .returning({
        id: solanaWebhookEvents.id,
        transactionSignature:
          solanaWebhookEvents.transactionSignature,
        transactionSlot: solanaWebhookEvents.transactionSlot,
        accountAddress: solanaWebhookEvents.accountAddress,
        attempts: solanaWebhookEvents.attempts
      });
  });
}

export async function updateSolanaWebhookEventState(
  db: Database,
  input: {
    id: string;
    status: "finalized" | "failed" | "retry_pending" | "dead_letter";
    nextAttemptAt?: Date | null;
    errorCode?: string | null;
    finalizedAt?: Date | null;
    processedAt?: Date | null;
    now?: Date;
  }
) {
  const now = input.now ?? new Date();
  const rows = await db
    .update(solanaWebhookEvents)
    .set({
      status: input.status,
      nextAttemptAt: input.nextAttemptAt ?? null,
      lastErrorCode: input.errorCode ?? null,
      finalizedAt: input.finalizedAt ?? null,
      processedAt: input.processedAt ?? null
    })
    .where(
      and(
        eq(solanaWebhookEvents.id, input.id),
        eq(solanaWebhookEvents.status, "processing")
      )
    )
    .returning({ id: solanaWebhookEvents.id });
  return rows[0] ?? null;
}

type WorkspaceDeadLetterScope = {
  accountAddresses: string[];
  transactionSignatures: string[];
};

function uniqueWebhookScopeValues(values: Array<string | null | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => typeof value === "string" && value.length > 0))];
}

async function loadWorkspaceDeadLetterScope<Executor extends Pick<Database, "select">>(
  db: Executor,
  workspaceId: string
): Promise<WorkspaceDeadLetterScope> {
  const [
    reserves,
    gasTanks,
    confidentialAccounts,
    allocations,
    gasTankOperationsForWorkspace,
    offboarding,
    recoveries,
    payrollRunsForWorkspace,
    subscriptionPaymentsForWorkspace,
    subscriptionAttempts
  ] = await Promise.all([
    db.select({
      address: workspaceReserves.address,
      setupSignature: workspaceReserves.confidentialAccountSetupSignature,
      programSetupSignature: workspaceReserves.programReserveSetupSignature
    }).from(workspaceReserves).where(eq(workspaceReserves.workspaceId, workspaceId)),
    db.select({ address: workspaceGasTanks.address })
      .from(workspaceGasTanks)
      .where(eq(workspaceGasTanks.workspaceId, workspaceId)),
    db.select({
      address: contributorConfidentialAccounts.tokenAccountAddress,
      setupSignature: contributorConfidentialAccounts.setupTransactionSignature,
      closeSignature: contributorConfidentialAccounts.closeTransactionSignature
    }).from(contributorConfidentialAccounts)
      .where(eq(contributorConfidentialAccounts.workspaceId, workspaceId)),
    db.select({
      claimAddress: payrollAllocations.claimAddress,
      transactionSignature: payrollAllocations.transactionSignature,
      settlementSignature: payrollAllocations.settlementSignature
    }).from(payrollAllocations)
      .where(eq(payrollAllocations.workspaceId, workspaceId)),
    db.select({ transactionSignature: gasTankOperations.transactionSignature })
      .from(gasTankOperations)
      .where(eq(gasTankOperations.workspaceId, workspaceId)),
    db.select({ closeTransactionSignature: contributorOffboarding.closeTransactionSignature })
      .from(contributorOffboarding)
      .where(eq(contributorOffboarding.workspaceId, workspaceId)),
    db.select({ transactionSignature: payrollRecoveries.transactionSignature })
      .from(payrollRecoveries)
      .where(eq(payrollRecoveries.workspaceId, workspaceId)),
    db.select({ submissionSignature: payrollRuns.submissionSignature })
      .from(payrollRuns)
      .where(eq(payrollRuns.workspaceId, workspaceId)),
    db.select({ signature: subscriptionPayments.signature })
      .from(subscriptionPayments)
      .where(eq(subscriptionPayments.workspaceId, workspaceId)),
    db.select({ signature: subscriptionPaymentAttempts.signature })
      .from(subscriptionPaymentAttempts)
      .where(eq(subscriptionPaymentAttempts.workspaceId, workspaceId))
  ]);

  return {
    accountAddresses: uniqueWebhookScopeValues([
      ...reserves.map((row) => row.address),
      ...gasTanks.map((row) => row.address),
      ...confidentialAccounts.map((row) => row.address),
      ...allocations.map((row) => row.claimAddress)
    ]),
    transactionSignatures: uniqueWebhookScopeValues([
      ...reserves.flatMap((row) => [row.setupSignature, row.programSetupSignature]),
      ...confidentialAccounts.flatMap((row) => [row.setupSignature, row.closeSignature]),
      ...allocations.flatMap((row) => [row.transactionSignature, row.settlementSignature]),
      ...gasTankOperationsForWorkspace.map((row) => row.transactionSignature),
      ...offboarding.map((row) => row.closeTransactionSignature),
      ...recoveries.map((row) => row.transactionSignature),
      ...payrollRunsForWorkspace.map((row) => row.submissionSignature),
      ...subscriptionPaymentsForWorkspace.map((row) => row.signature),
      ...subscriptionAttempts.map((row) => row.signature)
    ])
  };
}

function workspaceDeadLetterScopeCondition(scope: WorkspaceDeadLetterScope) {
  const conditions = [];
  if (scope.accountAddresses.length > 0) {
    conditions.push(inArray(solanaWebhookEvents.accountAddress, scope.accountAddresses));
  }
  if (scope.transactionSignatures.length > 0) {
    conditions.push(inArray(solanaWebhookEvents.transactionSignature, scope.transactionSignatures));
  }
  return or(...conditions);
}

export async function listWorkspaceDeadLetterSolanaWebhookEvents(
  db: Database,
  input: { workspaceId: string; limit?: number }
) {
  const limit = Math.min(Math.max(Math.trunc(input.limit ?? 50) || 1, 1), 100);
  const scope = await loadWorkspaceDeadLetterScope(db, input.workspaceId);
  const scopeCondition = workspaceDeadLetterScopeCondition(scope);
  if (!scopeCondition) return [];

  return db
    .select({
      id: solanaWebhookEvents.id,
      transactionSignature: solanaWebhookEvents.transactionSignature,
      transactionSlot: solanaWebhookEvents.transactionSlot,
      eventType: solanaWebhookEvents.eventType,
      status: solanaWebhookEvents.status,
      attempts: solanaWebhookEvents.attempts,
      lastErrorCode: solanaWebhookEvents.lastErrorCode,
      receivedAt: solanaWebhookEvents.receivedAt,
      processedAt: solanaWebhookEvents.processedAt
    })
    .from(solanaWebhookEvents)
    .where(and(
      eq(solanaWebhookEvents.status, "dead_letter"),
      scopeCondition
    ))
    .orderBy(desc(solanaWebhookEvents.receivedAt))
    .limit(limit);
}

export async function retryDeadLetterSolanaWebhookEvent(
  db: Database,
  input: { workspaceId: string; eventId: string; now?: Date }
) {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const scope = await loadWorkspaceDeadLetterScope(tx, input.workspaceId);
    const scopeCondition = workspaceDeadLetterScopeCondition(scope);
    if (!scopeCondition) return false;

    const matching = await tx
      .select({ id: solanaWebhookEvents.id })
      .from(solanaWebhookEvents)
      .where(and(
        eq(solanaWebhookEvents.id, input.eventId),
        eq(solanaWebhookEvents.status, "dead_letter"),
        scopeCondition
      ))
      .for("update")
      .limit(1);
    if (!matching[0]) return false;
    const updated = await tx
      .update(solanaWebhookEvents)
      .set({
        status: "retry_pending",
        attempts: 0,
        nextAttemptAt: now,
        lastErrorCode: null,
        processedAt: null,
        finalizedAt: null
      })
      .where(and(
        eq(solanaWebhookEvents.id, input.eventId),
        eq(solanaWebhookEvents.status, "dead_letter"),
        scopeCondition
      ))
      .returning({ id: solanaWebhookEvents.id });
    return updated.length === 1;
  });
}

export async function listWorkspaceLedgerEntries(
  db: Database,
  input: {
    workspaceId: string;
    category?: string;
    status?: string;
    createdAfter?: Date;
    createdBefore?: Date;
    limit?: number;
    before?: { createdAt: Date; id: string };
  }
) {
  const conditions = [
    eq(workspaceLedgerEntries.workspaceId, input.workspaceId)
  ];
  if (input.category) {
    conditions.push(eq(workspaceLedgerEntries.category, input.category));
  }
  if (input.status) {
    conditions.push(eq(workspaceLedgerEntries.status, input.status));
  }
  if (input.createdAfter) {
    conditions.push(gte(workspaceLedgerEntries.createdAt, input.createdAfter));
  }
  if (input.createdBefore) {
    conditions.push(lt(workspaceLedgerEntries.createdAt, input.createdBefore));
  }
  if (input.before) {
    conditions.push(
      or(
        lt(
          workspaceLedgerEntries.createdAt,
          input.before.createdAt
        ),
        and(
          eq(
            workspaceLedgerEntries.createdAt,
            input.before.createdAt
          ),
          lt(workspaceLedgerEntries.id, input.before.id)
        )
      )!
    );
  }
  return db
    .select()
    .from(workspaceLedgerEntries)
    .where(and(...conditions))
    .orderBy(desc(workspaceLedgerEntries.createdAt))
    .limit(Math.min(Math.max(input.limit ?? 50, 1), 101));
}

export async function createWorkspaceNotificationForFinanceMembers(
  db: Database,
  input: {
    workspaceId: string;
    eventKey: string;
    category: string;
    title: string;
    body: string;
    destination?: string | null;
    now?: Date;
  }
) {
  const members = await db
    .select({ userId: workspaceMemberships.userId })
    .from(workspaceMemberships)
    .where(
      and(
        eq(workspaceMemberships.workspaceId, input.workspaceId),
        or(
          eq(workspaceMemberships.role, "organization_admin"),
          eq(workspaceMemberships.role, "finance_auditor")
        )
      )
    );
  if (members.length === 0) return 0;
  const rows = await db
    .insert(workspaceNotifications)
    .values(
      members.map((member) => ({
        workspaceId: input.workspaceId,
        recipientKey: member.userId,
        eventKey: input.eventKey,
        category: input.category,
        title: input.title,
        body: input.body,
        destination: input.destination ?? null,
        createdAt: input.now ?? new Date()
      }))
    )
    .onConflictDoNothing({
      target: [
        workspaceNotifications.workspaceId,
        workspaceNotifications.eventKey,
        workspaceNotifications.recipientKey
      ]
    })
    .returning({ id: workspaceNotifications.id });
  return rows.length;
}


export async function notifySubscriptionPaymentFailure(
  db: Database,
  input: {
    workspaceId: string;
    userId: string;
    signature: string;
    reason: "transaction_failed" | "intent_mismatch";
    now?: Date;
  }
) {
  const now = input.now ?? new Date();
  const isMismatch = input.reason === "intent_mismatch";
  const eventKey = `subscription-payment-failure:${input.signature}`;
  return db.transaction(async (tx) => {
    const financeMembers = await tx
      .select({ userId: workspaceMemberships.userId })
      .from(workspaceMemberships)
      .where(and(
        eq(workspaceMemberships.workspaceId, input.workspaceId),
        or(
          eq(workspaceMemberships.role, "organization_admin"),
          eq(workspaceMemberships.role, "finance_auditor")
        )
      ));
    const recipientKeys = [...new Set([
      input.userId,
      ...financeMembers.map((member) => member.userId)
    ])];
    if (recipientKeys.length === 0) return 0;

    const title = isMismatch
      ? "Subscription payment was not accepted"
      : "Subscription payment failed";
    const body = isMismatch
      ? "The finalized transaction did not match the expected payer, recipient, token, or amount. Paylore did not apply it as a subscription payment. Review billing details before submitting another payment."
      : "The finalized Solana transaction failed, so Paylore did not apply it as a subscription payment. Review billing before submitting another payment.";
    const inserted = await tx
      .insert(workspaceNotifications)
      .values(recipientKeys.map((recipientKey) => ({
        workspaceId: input.workspaceId,
        recipientKey,
        eventKey,
        category: "Workspace & Billing",
        title,
        body,
        destination: `/workspace/${input.workspaceId}/billing`,
        createdAt: now
      })))
      .onConflictDoNothing({
        target: [
          workspaceNotifications.workspaceId,
          workspaceNotifications.eventKey,
          workspaceNotifications.recipientKey
        ]
      })
      .returning({ id: workspaceNotifications.id });
    return inserted.length;
  });
}

export async function listWorkspaceNotifications(
  db: Database,
  input: {
    workspaceId: string;
    recipientKey: string;
    category?: string;
    unreadOnly?: boolean;
    limit?: number;
  }
) {
  const conditions = [
    eq(workspaceNotifications.workspaceId, input.workspaceId),
    eq(workspaceNotifications.recipientKey, input.recipientKey)
  ];
  if (input.unreadOnly) {
    conditions.push(isNull(workspaceNotifications.readAt));
  }
  if (input.category) {
    conditions.push(eq(workspaceNotifications.category, input.category));
  }
  return db
    .select()
    .from(workspaceNotifications)
    .where(and(...conditions))
    .orderBy(desc(workspaceNotifications.createdAt))
    .limit(Math.min(Math.max(input.limit ?? 50, 1), 100));
}

export async function markWorkspaceNotificationRead(
  db: Database,
  input: {
    workspaceId: string;
    notificationId: string;
    recipientKey: string;
    now?: Date;
  }
) {
  const rows = await db
    .update(workspaceNotifications)
    .set({ readAt: input.now ?? new Date() })
    .where(
      and(
        eq(workspaceNotifications.workspaceId, input.workspaceId),
        eq(workspaceNotifications.id, input.notificationId),
        eq(workspaceNotifications.recipientKey, input.recipientKey),
        isNull(workspaceNotifications.readAt)
      )
    )
    .returning({ id: workspaceNotifications.id });
  return rows[0] ?? null;
}

export async function markAllWorkspaceNotificationsRead(
  db: Database,
  input: {
    workspaceId: string;
    recipientKey: string;
    now?: Date;
  }
) {
  const rows = await db
    .update(workspaceNotifications)
    .set({ readAt: input.now ?? new Date() })
    .where(
      and(
        eq(workspaceNotifications.workspaceId, input.workspaceId),
        eq(workspaceNotifications.recipientKey, input.recipientKey),
        isNull(workspaceNotifications.readAt)
      )
    )
    .returning({ id: workspaceNotifications.id });
  return rows.length;
}

export async function getWorkspaceDeletionState(
  db: Database,
  workspaceId: string
) {
  const rows = await db
    .select()
    .from(workspaceRetention)
    .where(eq(workspaceRetention.workspaceId, workspaceId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getWorkspaceDeletionAudit(
  db: Database,
  workspaceId: string
) {
  const rows = await db
    .select()
    .from(workspaceDeletionAudit)
    .where(eq(workspaceDeletionAudit.workspaceId, workspaceId))
    .limit(1);
  return rows[0] ?? null;
}

export async function getWorkspaceDeletionBlockers(
  db: Database,
  workspaceId: string
) {
  const [gasTanks, reserves, allocations, runs, confidentialAccounts] =
    await Promise.all([
      db
        .select({ balanceLamports: workspaceGasTanks.balanceLamports })
        .from(workspaceGasTanks)
        .where(eq(workspaceGasTanks.workspaceId, workspaceId))
        .limit(1),
      db
        .select({ workspaceId: workspaceReserves.workspaceId })
        .from(workspaceReserves)
        .where(eq(workspaceReserves.workspaceId, workspaceId))
        .limit(1),
      db
        .select({ id: payrollAllocations.id })
        .from(payrollAllocations)
        .where(
          and(
            eq(payrollAllocations.workspaceId, workspaceId),
            notInArray(payrollAllocations.status, [
              "claimed",
              "recovered",
              "cancelled"
            ])
          )
        )
        .limit(1),
      db
        .select({ id: payrollRuns.id })
        .from(payrollRuns)
        .where(
          and(
            eq(payrollRuns.workspaceId, workspaceId),
            notInArray(payrollRuns.status, ["complete", "cancelled"])
          )
        )
        .limit(1),
      db
        .select({
          contributorId: contributorConfidentialAccounts.contributorId
        })
        .from(contributorConfidentialAccounts)
        .where(
          and(
            eq(contributorConfidentialAccounts.workspaceId, workspaceId),
            notInArray(contributorConfidentialAccounts.status, ["closed"])
          )
        )
        .limit(1)
    ]);
  const gasTankBalanceLamports = gasTanks[0]?.balanceLamports ?? null;
  return {
    gasTank:
      gasTankBalanceLamports === null
        ? "not_configured" as const
        : BigInt(gasTankBalanceLamports) > 0n
          ? "funds_remain" as const
          : "closure_unverified" as const,
    reserve: reserves.length > 0,
    outstandingPayroll: allocations.length > 0 || runs.length > 0,
    confidentialAccounts: confidentialAccounts.length > 0
  };
}

export async function listDueWorkspaceRetentionNotifications(
  db: Database,
  limit = 100
) {
  return db
    .select({
      workspaceId: workspaceRetention.workspaceId,
      lastActivityAt: workspaceRetention.lastActivityAt,
      lastNoticeDay: workspaceRetention.lastNoticeDay
    })
    .from(workspaceRetention)
    .where(lt(workspaceRetention.lastNoticeDay, 330))
    .orderBy(asc(workspaceRetention.lastActivityAt))
    .limit(Math.min(Math.max(limit, 1), 500));
}

export async function createWorkspaceRetentionNotice(
  db: Database,
  input: {
    workspaceId: string;
    lastActivityAt: Date;
    day: number;
    title: string;
    body: string;
    destination: string;
    now: Date;
  }
) {
  return db.transaction(async (tx) => {
    const states = await tx
      .select({
        lastActivityAt: workspaceRetention.lastActivityAt,
        lastNoticeDay: workspaceRetention.lastNoticeDay
      })
      .from(workspaceRetention)
      .where(eq(workspaceRetention.workspaceId, input.workspaceId))
      .for("update")
      .limit(1);
    const state = states[0];
    if (
      !state ||
      state.lastActivityAt.getTime() !== input.lastActivityAt.getTime() ||
      state.lastNoticeDay >= input.day ||
      !hasReachedInactivityThreshold(
        state.lastActivityAt,
        input.day,
        input.now
      )
    ) {
      return { created: 0, advanced: false };
    }

    const members = await tx
      .select({ userId: workspaceMemberships.userId })
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, input.workspaceId));
    const inserted = members.length
      ? await tx
          .insert(workspaceNotifications)
          .values(
            members.map((member) => ({
              workspaceId: input.workspaceId,
              recipientKey: member.userId,
              eventKey: `workspace-inactivity:${input.lastActivityAt.getTime()}:${input.day}`,
              category: "Data Retention & Deletion",
              title: input.title,
              body: input.body,
              destination: input.destination,
              createdAt: input.now
            }))
          )
          .onConflictDoNothing({
            target: [
              workspaceNotifications.workspaceId,
              workspaceNotifications.eventKey,
              workspaceNotifications.recipientKey
            ]
          })
          .returning({ id: workspaceNotifications.id })
      : [];

    await tx
      .update(workspaceRetention)
      .set({ lastNoticeDay: input.day, updatedAt: input.now })
      .where(eq(workspaceRetention.workspaceId, input.workspaceId));
    return { created: inserted.length, advanced: true };
  });
}

export async function createDueSubscriptionRenewalReminders(
  db: Database,
  now: Date,
  limit = 500
) {
  const boundedLimit = Math.min(Math.max(Math.trunc(limit) || 1, 1), 500);
  return db.transaction(async (tx) => {
    const subscriptions = await tx
      .select({
        workspaceId: workspaceSubscriptions.workspaceId,
        periodEnd: workspaceSubscriptions.periodEnd,
        status: workspaceSubscriptions.status
      })
      .from(workspaceSubscriptions)
      .where(and(
        inArray(workspaceSubscriptions.status, ["active", "cancel_scheduled"]),
        gt(workspaceSubscriptions.periodEnd, now)
      ))
      .orderBy(asc(workspaceSubscriptions.periodEnd))
      .limit(boundedLimit);

    let subscriptionsProcessed = 0;
    let notificationsCreated = 0;
    let ledgerEntriesCreated = 0;
    for (const subscription of subscriptions) {
      if (!subscription.periodEnd) continue;
      const daysRemaining = getSubscriptionDaysRemaining(subscription.periodEnd, now);
      const dueDays = getDueSubscriptionRenewalReminderDays(subscription.periodEnd, now);
      if (dueDays.length === 0 || daysRemaining === null) continue;
      subscriptionsProcessed += 1;
      const members = await tx
        .select({ userId: workspaceMemberships.userId })
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.workspaceId, subscription.workspaceId));
      if (members.length === 0) continue;

      const canceled = subscription.status === "cancel_scheduled";
      const notices = dueDays.flatMap((days) => members.map((member) => ({
        workspaceId: subscription.workspaceId,
        recipientKey: member.userId,
        eventKey: "subscription-renewal-reminder:" + subscription.periodEnd!.getTime() + ":" + days,
        category: "Workspace & Billing",
        title: "Subscription expires soon",
        body: canceled
          ? "Your workspace subscription ends in " + daysRemaining + " day" + (daysRemaining === 1 ? "" : "s") + ". Cancellation is scheduled at the end of the paid period. Renew manually before then to keep normal workspace operations available."
          : "Your workspace subscription ends in " + daysRemaining + " day" + (daysRemaining === 1 ? "" : "s") + ". Renewal is manual. Review billing to renew before the paid period ends and avoid Read-Only Archive.",
        destination: "/workspace/" + subscription.workspaceId + "/billing",
        createdAt: now
      })));
      const insertedNotifications = await tx
        .insert(workspaceNotifications)
        .values(notices)
        .onConflictDoNothing({
          target: [
            workspaceNotifications.workspaceId,
            workspaceNotifications.eventKey,
            workspaceNotifications.recipientKey
          ]
        })
        .returning({ id: workspaceNotifications.id });
      notificationsCreated += insertedNotifications.length;

      const reminderLedgerEntries = dueDays.map((days) => ({
        workspaceId: subscription.workspaceId,
        idempotencyKey: "subscription-renewal-reminder:" + subscription.periodEnd!.getTime() + ":" + days,
        category: "billing",
        entryType: "subscription_renewal_reminder",
        status: "finalized",
        amountBaseUnits: null,
        mint: null,
        referenceType: "workspace_subscription",
        referenceId: subscription.workspaceId,
        transactionSignature: null,
        metadata: {
          financial: false,
          periodEnd: subscription.periodEnd!.toISOString(),
          reminderDays: days,
          cancellationScheduled: canceled
        },
        createdAt: now
      }));
      const insertedLedgerEntries = await tx
        .insert(workspaceLedgerEntries)
        .values(reminderLedgerEntries)
        .onConflictDoNothing({
          target: [
            workspaceLedgerEntries.workspaceId,
            workspaceLedgerEntries.idempotencyKey
          ]
        })
        .returning({ id: workspaceLedgerEntries.id });
      ledgerEntriesCreated += insertedLedgerEntries.length;
    }
    return { subscriptionsProcessed, notificationsCreated, ledgerEntriesCreated };
  });
}

export async function archiveExpiredWorkspaceSubscriptions(
  db: Database,
  now: Date
) {
  return db.transaction(async (tx) => {
    const expired = await tx
      .update(workspaceSubscriptions)
      .set({
        status: "archived",
        cancelAtPeriodEnd: false,
        updatedAt: now
      })
      .where(
        and(
          lte(workspaceSubscriptions.periodEnd, now),
          or(
            eq(workspaceSubscriptions.status, "active"),
            eq(workspaceSubscriptions.status, "cancel_scheduled")
          )
        )
      )
      .returning({
        workspaceId: workspaceSubscriptions.workspaceId,
        periodEnd: workspaceSubscriptions.periodEnd
      });
    for (const subscription of expired) {
      await tx
        .insert(workspaceRetention)
        .values({
          workspaceId: subscription.workspaceId,
          closedAt: now,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: workspaceRetention.workspaceId,
          set: {
            closedAt: now,
            updatedAt: now
          }
        });
      const members = await tx
        .select({ userId: workspaceMemberships.userId })
        .from(workspaceMemberships)
        .where(
          eq(workspaceMemberships.workspaceId, subscription.workspaceId)
        );
      if (members.length > 0) {
        await tx
          .insert(workspaceNotifications)
          .values(
            members.map((member) => ({
              workspaceId: subscription.workspaceId,
              recipientKey: member.userId,
              eventKey: `workspace-archived:${subscription.workspaceId}:${subscription.periodEnd?.getTime() ?? "unknown"}`,
              category: "Workspace & Billing",
              title: "Workspace is now in Read-Only Archive",
              body: "This workspace subscription has expired. Existing qualifying claims and obligations remain available for settlement. New paid-only changes are unavailable until the workspace is renewed.",
              destination: `/workspace/${subscription.workspaceId}/billing`,
              createdAt: now
            }))
          )
          .onConflictDoNothing({
            target: [
              workspaceNotifications.workspaceId,
              workspaceNotifications.eventKey,
              workspaceNotifications.recipientKey
            ]
          });
      }
    }
    return expired.length;
  });
}

export async function requestWorkspaceDeletion(
  db: Database,
  workspaceId: string,
  now = new Date()
) {
  const scheduledAt = scheduleWorkspaceDeletion(now);
  return db.transaction(async (tx) => {
    const notifyPending = async (scheduled: Date) => {
      await tx.insert(workspaceLedgerEntries).values({
        workspaceId,
        idempotencyKey: `workspace-deletion-request:${scheduled.getTime()}`,
        category: "recovery",
        entryType: "workspace_deletion_requested",
        status: "pending",
        amountBaseUnits: null,
        mint: null,
        referenceType: "workspace",
        referenceId: workspaceId,
        metadata: {
          outcome: "pending",
          scheduledAt: scheduled.toISOString(),
          financialValueVerified: false,
          amountOmittedReason: "non_financial_outcome"
        },
        createdAt: now
      }).onConflictDoNothing({
        target: [workspaceLedgerEntries.workspaceId, workspaceLedgerEntries.idempotencyKey]
      });
      const members = await tx
        .select({ userId: workspaceMemberships.userId })
        .from(workspaceMemberships)
        .where(eq(workspaceMemberships.workspaceId, workspaceId));
      if (members.length === 0) return;
      await tx
        .insert(workspaceNotifications)
        .values(
          members.map((member) => ({
            workspaceId,
            recipientKey: member.userId,
            eventKey: `workspace-deletion-pending:${scheduled.getTime()}`,
            category: "Data Retention & Deletion",
            title: "Workspace deletion is pending",
            body: "Workspace application-data deletion is scheduled after a 72-hour waiting period. Solana transactions, program accounts, token accounts, and other blockchain state will not be deleted.",
            destination: `/workspace/${workspaceId}/settings/deletion`,
            createdAt: now
          }))
        )
        .onConflictDoNothing({
          target: [
            workspaceNotifications.workspaceId,
            workspaceNotifications.eventKey,
            workspaceNotifications.recipientKey
          ]
        });
    };
    const existing = await tx
      .select()
      .from(workspaceRetention)
      .where(eq(workspaceRetention.workspaceId, workspaceId))
      .for("update")
      .limit(1);
    if (
      existing[0]?.deletionScheduledAt &&
      !existing[0].deletionCanceledAt
    ) {
      await tx
        .insert(workspaceDeletionAudit)
        .values({
          workspaceId,
          requestedAt: existing[0].deletionRequestedAt,
          scheduledAt: existing[0].deletionScheduledAt,
          outcome: "pending",
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: workspaceDeletionAudit.workspaceId,
          set: {
            canceledAt: null,
            completedAt: null,
            outcome: "pending",
            blockerCode: null,
            updatedAt: now
          }
        });
      await notifyPending(existing[0].deletionScheduledAt);
      return {
        created: false,
        requestedAt: existing[0].deletionRequestedAt,
        scheduledAt: existing[0].deletionScheduledAt
      };
    }
    if (existing[0]) {
      const [updated] = await tx
        .update(workspaceRetention)
        .set({
          deletionRequestedAt: now,
          deletionScheduledAt: scheduledAt,
          deletionCanceledAt: null,
          updatedAt: now
        })
        .where(eq(workspaceRetention.workspaceId, workspaceId))
        .returning({
          deletionRequestedAt: workspaceRetention.deletionRequestedAt,
          deletionScheduledAt: workspaceRetention.deletionScheduledAt
        });
      if (!updated.deletionScheduledAt) {
        throw new Error("The workspace deletion schedule could not be saved.");
      }
      await tx
        .insert(workspaceDeletionAudit)
        .values({
          workspaceId,
          requestedAt: updated.deletionRequestedAt,
          scheduledAt: updated.deletionScheduledAt,
          outcome: "pending",
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: workspaceDeletionAudit.workspaceId,
          set: {
            requestedAt: updated.deletionRequestedAt,
            scheduledAt: updated.deletionScheduledAt,
            canceledAt: null,
            completedAt: null,
            outcome: "pending",
            blockerCode: null,
            updatedAt: now
          }
        });
      await notifyPending(updated.deletionScheduledAt);
      return {
        created: true,
        requestedAt: updated.deletionRequestedAt,
        scheduledAt: updated.deletionScheduledAt
      };
    }
    const inserted = await tx
      .insert(workspaceRetention)
      .values({
        workspaceId,
        lastActivityAt: now,
        deletionRequestedAt: now,
        deletionScheduledAt: scheduledAt
      })
      .returning({
        deletionRequestedAt: workspaceRetention.deletionRequestedAt,
        deletionScheduledAt: workspaceRetention.deletionScheduledAt
      })
      .onConflictDoNothing({
        target: workspaceRetention.workspaceId
      });
    const created = inserted[0];
    if (created) {
      if (!created.deletionScheduledAt) {
        throw new Error("The workspace deletion schedule could not be saved.");
      }
      await tx
        .insert(workspaceDeletionAudit)
        .values({
          workspaceId,
          requestedAt: created.deletionRequestedAt,
          scheduledAt: created.deletionScheduledAt,
          outcome: "pending",
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: workspaceDeletionAudit.workspaceId,
          set: {
            requestedAt: created.deletionRequestedAt,
            scheduledAt: created.deletionScheduledAt,
            canceledAt: null,
            completedAt: null,
            outcome: "pending",
            blockerCode: null,
            updatedAt: now
          }
        });
      await notifyPending(created.deletionScheduledAt);
      return {
        created: true,
        requestedAt: created.deletionRequestedAt,
        scheduledAt: created.deletionScheduledAt
      };
    }
    const concurrent = await tx
      .select({
        deletionRequestedAt: workspaceRetention.deletionRequestedAt,
        deletionScheduledAt: workspaceRetention.deletionScheduledAt
      })
      .from(workspaceRetention)
      .where(eq(workspaceRetention.workspaceId, workspaceId))
      .for("update")
      .limit(1);
    if (!concurrent[0]) {
      throw new Error("The workspace deletion request could not be saved.");
    }
    if (concurrent[0].deletionScheduledAt) {
      await notifyPending(concurrent[0].deletionScheduledAt);
    }
    return {
      created: false,
      requestedAt: concurrent[0].deletionRequestedAt,
      scheduledAt: concurrent[0].deletionScheduledAt
    };
  });
}

export async function cancelWorkspaceDeletion(
  db: Database,
  workspaceId: string,
  now = new Date()
) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(workspaceRetention)
      .set({
        deletionRequestedAt: null,
        deletionScheduledAt: null,
        deletionCanceledAt: now,
        updatedAt: now
      })
      .where(
        and(
          eq(workspaceRetention.workspaceId, workspaceId),
          gt(workspaceRetention.deletionScheduledAt, now),
          isNull(workspaceRetention.deletedAt)
        )
      )
      .returning({ workspaceId: workspaceRetention.workspaceId });
    if (!rows[0]) return null;
    await tx
      .insert(workspaceDeletionAudit)
      .values({
        workspaceId,
        canceledAt: now,
        outcome: "canceled",
        updatedAt: now
      })
      .onConflictDoUpdate({
        target: workspaceDeletionAudit.workspaceId,
        set: {
          canceledAt: now,
          outcome: "canceled",
          blockerCode: null,
          updatedAt: now
        }
      });
    await tx.insert(workspaceLedgerEntries).values({
      workspaceId,
      idempotencyKey: `workspace-deletion-canceled:${now.getTime()}`,
      category: "recovery",
      entryType: "workspace_deletion_canceled",
      status: "reversed",
      amountBaseUnits: null,
      mint: null,
      referenceType: "workspace",
      referenceId: workspaceId,
      metadata: {
        outcome: "canceled",
        financialValueVerified: false,
        amountOmittedReason: "non_financial_outcome"
      },
      createdAt: now
    }).onConflictDoNothing({
      target: [workspaceLedgerEntries.workspaceId, workspaceLedgerEntries.idempotencyKey]
    });
    const members = await tx
      .select({ userId: workspaceMemberships.userId })
      .from(workspaceMemberships)
      .where(eq(workspaceMemberships.workspaceId, workspaceId));
    if (members.length > 0) {
      await tx
        .insert(workspaceNotifications)
        .values(
          members.map((member) => ({
            workspaceId,
            recipientKey: member.userId,
            eventKey: `workspace-deletion-canceled:${now.getTime()}`,
            category: "Data Retention & Deletion",
            title: "Workspace deletion request canceled",
            body: "The pending application-data deletion request was canceled. No application data was deleted.",
            destination: `/workspace/${workspaceId}/settings/deletion`,
            createdAt: now
          }))
        )
        .onConflictDoNothing({
          target: [
            workspaceNotifications.workspaceId,
            workspaceNotifications.eventKey,
            workspaceNotifications.recipientKey
          ]
        });
    }
    return rows[0];
  });
}

export async function permanentlyDeleteEligibleWorkspace(
  db: Database,
  input: {
    workspaceId: string;
    now?: Date;
  }
) {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const retentionRows = await tx
      .select({
        deletionRequestedAt: workspaceRetention.deletionRequestedAt,
        deletionScheduledAt: workspaceRetention.deletionScheduledAt,
        deletionCanceledAt: workspaceRetention.deletionCanceledAt,
        deletedAt: workspaceRetention.deletedAt,
        lastActivityAt: workspaceRetention.lastActivityAt
      })
      .from(workspaceRetention)
      .where(eq(workspaceRetention.workspaceId, input.workspaceId))
      .for("update")
      .limit(1);
    const retention = retentionRows[0];
    const recordOutcome = async (
      outcome: string,
      blockerCode: string | null,
      completedAt: Date | null = null
    ) => {
      await tx
        .insert(workspaceDeletionAudit)
        .values({
          workspaceId: input.workspaceId,
          requestedAt: retention?.deletionRequestedAt ?? null,
          scheduledAt: retention?.deletionScheduledAt ?? null,
          canceledAt: retention?.deletionCanceledAt ?? null,
          completedAt,
          outcome,
          blockerCode,
          updatedAt: now
        })
        .onConflictDoUpdate({
          target: workspaceDeletionAudit.workspaceId,
          set: {
            requestedAt: retention?.deletionRequestedAt ?? null,
            scheduledAt: retention?.deletionScheduledAt ?? null,
            canceledAt: retention?.deletionCanceledAt ?? null,
            completedAt,
            outcome,
            blockerCode,
            updatedAt: now
          }
        });
    };

    // The audit row survives workspace cascades; keep a completed purge terminal on retries.
    const priorAuditRows = await tx
      .select({ outcome: workspaceDeletionAudit.outcome })
      .from(workspaceDeletionAudit)
      .where(eq(workspaceDeletionAudit.workspaceId, input.workspaceId))
      .for("update")
      .limit(1);
    if (priorAuditRows[0]?.outcome === "deleted") {
      return { status: "deleted" as const };
    }

    if (!retention?.deletionScheduledAt || retention.deletionCanceledAt) {
      await recordOutcome("blocked", "request_required");
      return { status: "request_required" as const };
    }
    if (retention.deletionScheduledAt > now) {
      await recordOutcome("pending", "waiting_period");
      return { status: "waiting_period" as const };
    }

    const subscriptionRows = await tx
      .select({ status: workspaceSubscriptions.status })
      .from(workspaceSubscriptions)
      .where(eq(workspaceSubscriptions.workspaceId, input.workspaceId))
      .limit(1);
    const inactiveDays = Math.floor(
      (now.getTime() - retention.lastActivityAt.getTime()) /
        (24 * 60 * 60 * 1000)
    );
    const retentionEligible = isWorkspaceRetentionEligible({
      inactiveDays,
      subscriptionStatus: subscriptionRows[0]?.status ?? null,
      gasTankConfigured: false,
      reserveConfigured: false,
      outstandingObligations: false
    });
    if (!retentionEligible) {
      const status =
        inactiveDays < 365
          ? "retention_period_not_reached" as const
          : "subscription_not_eligible" as const;
      await recordOutcome("blocked", status);
      return { status };
    }

    const gasTankRows = await tx
      .select({ balanceLamports: workspaceGasTanks.balanceLamports })
      .from(workspaceGasTanks)
      .where(eq(workspaceGasTanks.workspaceId, input.workspaceId))
      .limit(1);
    if (gasTankRows[0]) {
      const status =
        BigInt(gasTankRows[0].balanceLamports) > 0n
          ? "gas_tank_funds_remain" as const
          : "gas_tank_closure_unverified" as const;
      await recordOutcome("blocked", status);
      return { status };
    }

    const openConfidentialAccounts = await tx
      .select({ contributorId: contributorConfidentialAccounts.contributorId })
      .from(contributorConfidentialAccounts)
      .where(
        and(
          eq(contributorConfidentialAccounts.workspaceId, input.workspaceId),
          notInArray(contributorConfidentialAccounts.status, ["closed"])
        )
      )
      .limit(1);
    if (openConfidentialAccounts[0]) {
      await recordOutcome("blocked", "confidential_accounts_unclosed");
      return { status: "confidential_accounts_unclosed" as const };
    }

    const reserveRows = await tx
      .select({ workspaceId: workspaceReserves.workspaceId })
      .from(workspaceReserves)
      .where(eq(workspaceReserves.workspaceId, input.workspaceId))
      .limit(1);
    if (reserveRows[0]) {
      await recordOutcome("blocked", "reserve_closure_unverified");
      return { status: "reserve_closure_unverified" as const };
    }

    const openAllocations = await tx
      .select({ id: payrollAllocations.id })
      .from(payrollAllocations)
      .where(
        and(
          eq(payrollAllocations.workspaceId, input.workspaceId),
          notInArray(
            payrollAllocations.status,
            ["claimed", "recovered", "cancelled"]
          )
        )
      )
      .limit(1);
    if (openAllocations[0]) {
      await recordOutcome("blocked", "outstanding_payroll_obligations");
      return { status: "outstanding_payroll_obligations" as const };
    }

    const openRuns = await tx
      .select({ id: payrollRuns.id })
      .from(payrollRuns)
      .where(
        and(
          eq(payrollRuns.workspaceId, input.workspaceId),
          notInArray(payrollRuns.status, ["complete", "cancelled"])
        )
      )
      .limit(1);
    if (openRuns[0]) {
      await recordOutcome("blocked", "outstanding_payroll_obligations");
      return { status: "outstanding_payroll_obligations" as const };
    }

    const workspaceNameRows = await tx
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, input.workspaceId))
      .limit(1);
    const closureRecipients = await tx
      .select({
        userId: workspaceMemberships.userId,
        role: workspaceMemberships.role
      })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, input.workspaceId),
          or(
            eq(workspaceMemberships.role, "organization_admin"),
            eq(workspaceMemberships.role, "contributor")
          )
        )
      );

    await tx
      .delete(payrollRecoveries)
      .where(eq(payrollRecoveries.workspaceId, input.workspaceId));
    await tx
      .delete(payrollAllocations)
      .where(eq(payrollAllocations.workspaceId, input.workspaceId));
    await tx
      .delete(payrollRuns)
      .where(eq(payrollRuns.workspaceId, input.workspaceId));
    const removed = await tx
      .delete(workspaces)
      .where(eq(workspaces.id, input.workspaceId))
      .returning({ id: workspaces.id });
    if (!removed[0]) {
      await recordOutcome("blocked", "workspace_not_found");
      return { status: "workspace_not_found" as const };
    }

    const completionNotices = closureRecipients.map((recipient) => ({
      workspaceId: input.workspaceId,
      workspaceName: workspaceNameRows[0]?.name ?? "Former workspace",
      recipientKey: recipient.userId,
      eventKey: `workspace-deletion-completed:${input.workspaceId}`,
      category: "Data Retention & Deletion",
      title: "Workspace application data deleted",
      body: "The workspace's Paylore application records were deleted after the 72-hour waiting period and final eligibility checks. Solana transactions, program accounts, token accounts, and other blockchain state remain.",
      destination: "/notifications",
      createdAt: now
    }));
    if (completionNotices.length > 0) {
      await tx
        .insert(userNotifications)
        .values(completionNotices)
        .onConflictDoNothing({
          target: [
            userNotifications.recipientKey,
            userNotifications.eventKey
          ]
        });
    }
    await recordOutcome("deleted", null, now);
    return { status: "deleted" as const };
  });
}

export async function listWorkspacePayrollRuns(
  db: Database,
  workspaceId: string
) {
  return db
    .select()
    .from(payrollRuns)
    .where(eq(payrollRuns.workspaceId, workspaceId))
    .orderBy(desc(payrollRuns.createdAt))
    .limit(100);
}

export async function listWorkspacePayrollRecoveryQueue(
  db: Database,
  workspaceId: string
) {
  return db
    .select({
      allocationId: payrollAllocations.id,
      runId: payrollRuns.id,
      runCreatedAt: payrollRuns.createdAt,
      runStatus: payrollRuns.status,
      contributorId: contributors.id,
      contributorName: contributors.displayName,
      contributorWalletAddress: contributors.identityWalletAddress,
      amountBaseUnits: payrollAllocations.amountBaseUnits,
      claimId: payrollAllocations.claimId,
      claimAddress: payrollAllocations.claimAddress,
      claimState: payrollAllocations.status,
      transactionSignature: payrollAllocations.transactionSignature,
      escrowStatus: payrollClaimEscrows.status,
      recoverySignature: payrollClaimEscrows.recoverySignature,
      recoveredAt: payrollClaimEscrows.recoveredAt
    })
    .from(payrollAllocations)
    .innerJoin(
      payrollRuns,
      and(
        eq(payrollRuns.id, payrollAllocations.payrollRunId),
        eq(payrollRuns.workspaceId, workspaceId)
      )
    )
    .innerJoin(
      contributors,
      and(
        eq(contributors.id, payrollAllocations.contributorId),
        eq(contributors.workspaceId, workspaceId)
      )
    )
    .leftJoin(
      payrollClaimEscrows,
      and(
        eq(payrollClaimEscrows.allocationId, payrollAllocations.id),
        eq(payrollClaimEscrows.workspaceId, workspaceId),
        eq(payrollClaimEscrows.payrollRunId, payrollRuns.id)
      )
    )
    .where(eq(payrollAllocations.workspaceId, workspaceId))
    .orderBy(desc(payrollAllocations.updatedAt))
    ;
}

export async function getWorkspacePayrollRun(
  db: Database,
  workspaceId: string,
  runId: string
) {
  const rows = await db
    .select()
    .from(payrollRuns)
    .where(
      and(
        eq(payrollRuns.workspaceId, workspaceId),
        eq(payrollRuns.id, runId)
      )
    )
    .limit(1);
  if (!rows[0]) return null;

  const allocations = await db
    .select({
      id: payrollAllocations.id,
      workspaceId: payrollAllocations.workspaceId,
      payrollRunId: payrollAllocations.payrollRunId,
      contributorId: payrollAllocations.contributorId,
      contributorWalletAddress: contributors.identityWalletAddress,
      amountBaseUnits: payrollAllocations.amountBaseUnits,
      amountCommitment: payrollAllocations.amountCommitment,
      amountCommitmentProof: payrollAllocations.amountCommitmentProof,
      amountCommitmentLeafIndex: payrollAllocations.amountCommitmentLeafIndex,
      claimId: payrollAllocations.claimId,
      claimAddress: payrollAllocations.claimAddress,
      status: payrollAllocations.status,
      transactionSignature: payrollAllocations.transactionSignature,
      settlementSignature: payrollAllocations.settlementSignature,
      settlementSourceAvailableBefore: payrollAllocations.settlementSourceAvailableBefore,
      settlementProofContextAddresses: payrollAllocations.settlementProofContextAddresses,
      settlementContextSignatures: payrollAllocations.settlementContextSignatures,
      claimedAt: payrollAllocations.claimedAt,
      recoveredAt: payrollAllocations.recoveredAt,
      createdAt: payrollAllocations.createdAt,
      updatedAt: payrollAllocations.updatedAt,
      escrowStatus: payrollClaimEscrows.status,
      recoverySignature: payrollClaimEscrows.recoverySignature,
      recoveryApplySignature: payrollClaimEscrows.recoveryApplySignature,
      recoveryProofContextAddresses: payrollClaimEscrows.recoveryProofContextAddresses,
      recoveryContextSignatures: payrollClaimEscrows.recoveryContextSignatures
    })
    .from(payrollAllocations)
    .innerJoin(
      contributors,
      and(
        eq(contributors.id, payrollAllocations.contributorId),
        eq(contributors.workspaceId, payrollAllocations.workspaceId)
      )
    )
    .leftJoin(
      payrollClaimEscrows,
      and(
        eq(payrollClaimEscrows.allocationId, payrollAllocations.id),
        eq(payrollClaimEscrows.workspaceId, workspaceId),
        eq(payrollClaimEscrows.payrollRunId, runId)
      )
    )
    .where(
      and(
        eq(payrollAllocations.workspaceId, workspaceId),
        eq(payrollAllocations.payrollRunId, runId)
      )
    )
    .orderBy(asc(payrollAllocations.createdAt));
  return { run: rows[0], allocations };
}

export async function listContributorPayrollAllocations(
  db: Database,
  workspaceId: string,
  contributorId: string
) {
  return db
    .select({
      id: payrollAllocations.id,
      runId: payrollRuns.id,
      runCreatedAt: payrollRuns.createdAt,
      runStatus: payrollRuns.status,
      amountBaseUnits: payrollAllocations.amountBaseUnits,
      status: payrollAllocations.status,
      claimAddress: payrollAllocations.claimAddress,
      transactionSignature: payrollAllocations.transactionSignature,
      settlementSignature: payrollAllocations.settlementSignature,
      claimedAt: payrollAllocations.claimedAt,
      recoveredAt: payrollAllocations.recoveredAt
    })
    .from(payrollAllocations)
    .innerJoin(
      payrollRuns,
      and(
        eq(payrollRuns.id, payrollAllocations.payrollRunId),
        eq(payrollRuns.workspaceId, payrollAllocations.workspaceId)
      )
    )
    .where(
      and(
        eq(payrollAllocations.workspaceId, workspaceId),
        eq(payrollAllocations.contributorId, contributorId),
        inArray(payrollRuns.status, ["committed", "complete"])
      )
    )
    .orderBy(desc(payrollRuns.createdAt), desc(payrollAllocations.createdAt))
    .limit(100);
}

export async function getWorkspacePayrollRecoveryQueue(
  db: Database,
  workspaceId: string
) {
  return db
    .select({
      id: payrollAllocations.id,
      runId: payrollAllocations.payrollRunId,
      contributorId: payrollAllocations.contributorId,
      contributorWalletAddress: contributors.identityWalletAddress,
      amountBaseUnits: payrollAllocations.amountBaseUnits,
      claimId: payrollAllocations.claimId,
      claimAddress: payrollAllocations.claimAddress,
      status: payrollAllocations.status,
      runCreatedAt: payrollRuns.createdAt
    })
    .from(payrollAllocations)
    .innerJoin(
      payrollRuns,
      and(
        eq(payrollRuns.id, payrollAllocations.payrollRunId),
        eq(payrollRuns.workspaceId, payrollAllocations.workspaceId)
      )
    )
    .innerJoin(
      contributors,
      and(
        eq(contributors.id, payrollAllocations.contributorId),
        eq(contributors.workspaceId, payrollAllocations.workspaceId)
      )
    )
    .where(
      and(
        eq(payrollAllocations.workspaceId, workspaceId),
        eq(payrollAllocations.status, "unclaimed"),
        isNotNull(payrollAllocations.claimAddress)
      )
    )
    .orderBy(asc(payrollRuns.createdAt), asc(payrollAllocations.createdAt));
}

export async function recordPayrollClaimSubmission(
  db: Database,
  input: {
    workspaceId: string;
    runId: string;
    signature: string;
    programId: string;
    authorityAddress: string;
    claims: Array<{
      claimId: string;
      claimAddress: string;
      escrowTokenAccount: string;
    }>;
    now?: Date;
  }
) {
  if (input.claims.length === 0) {
    throw new Error("At least one verified payroll claim is required.");
  }
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const runRows = await tx
      .select({
        id: payrollRuns.id,
        status: payrollRuns.status,
        allocationCommitment: payrollRuns.allocationCommitment
      })
      .from(payrollRuns)
      .where(
        and(
          eq(payrollRuns.workspaceId, input.workspaceId),
          eq(payrollRuns.id, input.runId)
        )
      )
      .for("update")
      .limit(1);
    const run = runRows[0];
    if (!run || !run.allocationCommitment) {
      return { status: "not_found" as const };
    }
    if (
      run.status !== "commit_pending" &&
      run.status !== "submitting" &&
      run.status !== "committed" &&
      run.status !== "complete"
    ) {
      return { status: "invalid_state" as const };
    }

    const claimIds = input.claims.map((claim) => claim.claimId);
    if (new Set(claimIds).size !== claimIds.length) {
      return { status: "invalid_claims" as const };
    }
    const rows = await tx
      .select()
      .from(payrollAllocations)
      .where(
        and(
          eq(payrollAllocations.workspaceId, input.workspaceId),
          eq(payrollAllocations.payrollRunId, input.runId),
          inArray(payrollAllocations.claimId, claimIds)
        )
      )
      .for("update");
    if (rows.length !== input.claims.length) {
      return { status: "invalid_claims" as const };
    }

    const escrowRows = await tx
      .select()
      .from(payrollClaimEscrows)
      .where(and(
        eq(payrollClaimEscrows.workspaceId, input.workspaceId),
        eq(payrollClaimEscrows.payrollRunId, input.runId),
        inArray(payrollClaimEscrows.allocationId, rows.map((allocation) => allocation.id))
      ))
      .for("update");
    if (escrowRows.length !== input.claims.length) {
      return { status: "escrow_not_ready" as const };
    }
    const byClaimId = new Map(input.claims.map((claim) => [claim.claimId, claim]));
    for (const allocation of rows) {
      const submitted = byClaimId.get(allocation.claimId);
      const escrow = escrowRows.find((item) => item.allocationId === allocation.id);
      if (!submitted || !escrow ||
          escrow.claimId !== submitted.claimId ||
          escrow.tokenAccountAddress !== submitted.escrowTokenAccount ||
          !["ready", "funding", "funded"].includes(escrow.status)) {
        return { status: "escrow_identity_conflict" as const };
      }
    }
    const sameFinalizedReplay = rows.every((allocation) => {
      const submitted = byClaimId.get(allocation.claimId);
      return submitted !== undefined &&
        allocation.claimAddress === submitted.claimAddress &&
        allocation.transactionSignature === input.signature &&
        ["unclaimed", "claimed", "recovered"].includes(allocation.status);
    });
    if (sameFinalizedReplay) {
      return {
        status: "duplicate" as const,
        submittedCount: rows.length,
        totalCount: rows.length
      };
    }

    const terminalAllocationsMatch = run.status === "complete" &&
      rows.every((allocation) => {
        const submitted = byClaimId.get(allocation.claimId);
        return submitted !== undefined &&
          allocation.claimAddress === submitted.claimAddress &&
          (allocation.status === "claimed" || allocation.status === "recovered");
      });
    if (terminalAllocationsMatch) {
      const priorLedgerRows = await tx
        .select({ metadata: workspaceLedgerEntries.metadata })
        .from(workspaceLedgerEntries)
        .where(and(
          eq(workspaceLedgerEntries.workspaceId, input.workspaceId),
          eq(workspaceLedgerEntries.idempotencyKey, `payroll-claim-commit:${input.runId}:${input.signature}`)
        ))
        .limit(1);
      const priorMetadata = priorLedgerRows[0]?.metadata;
      const metadata = priorMetadata !== null &&
        typeof priorMetadata === "object" &&
        !Array.isArray(priorMetadata)
        ? priorMetadata as Record<string, unknown>
        : null;
      const recordedClaims = metadata && Array.isArray(metadata.claims)
        ? metadata.claims.filter((claim): claim is { claimId: string; claimAddress: string } =>
            claim !== null &&
            typeof claim === "object" &&
            !Array.isArray(claim) &&
            typeof (claim as Record<string, unknown>).claimId === "string" &&
            typeof (claim as Record<string, unknown>).claimAddress === "string"
          )
        : [];
      const recordedClaimsMatch = recordedClaims.length === input.claims.length &&
        input.claims.every((submitted) => recordedClaims.some((recorded) =>
          recorded.claimId === submitted.claimId &&
          recorded.claimAddress === submitted.claimAddress
        ));
      if (
        metadata &&
        metadata.programId === input.programId &&
        metadata.authorityAddress === input.authorityAddress &&
        metadata.allocationCommitment === run.allocationCommitment &&
        recordedClaimsMatch
      ) {
        return {
          status: "duplicate" as const,
          submittedCount: rows.length,
          totalCount: rows.length
        };
      }
      return { status: "claim_conflict" as const };
    }
    if (run.status === "complete") {
      return { status: "claim_conflict" as const };
    }

    for (const allocation of rows) {
      const submitted = byClaimId.get(allocation.claimId);
      if (!submitted) {
        return { status: "invalid_claims" as const };
      }
      if (
        allocation.claimAddress !== null &&
        allocation.claimAddress !== submitted.claimAddress
      ) {
        return { status: "claim_conflict" as const };
      }
      if (
        allocation.transactionSignature !== null &&
        (
          allocation.transactionSignature !== input.signature ||
          allocation.claimAddress === null
        )
      ) {
        return { status: "claim_conflict" as const };
      }
      if (
        allocation.status !== "draft" &&
        allocation.status !== "unclaimed"
      ) {
        return { status: "claim_conflict" as const };
      }
    }

    await tx
      .update(payrollAllocations)
      .set({
        status: "unclaimed",
        transactionSignature: input.signature,
        updatedAt: now
      })
      .where(
        and(
          eq(payrollAllocations.workspaceId, input.workspaceId),
          eq(payrollAllocations.payrollRunId, input.runId),
          inArray(payrollAllocations.claimId, claimIds)
        )
      );

    for (const claim of input.claims) {
      const allocation = rows.find((row) => row.claimId === claim.claimId);
      if (!allocation || allocation.claimAddress !== null) continue;
      await tx
        .update(payrollAllocations)
        .set({
          claimAddress: claim.claimAddress,
          status: "unclaimed",
          transactionSignature: input.signature,
          updatedAt: now
        })
        .where(
          and(
            eq(payrollAllocations.id, allocation.id),
            isNull(payrollAllocations.claimAddress)
          )
        );
    }

    const allAllocations = await tx
      .select({
        claimAddress: payrollAllocations.claimAddress
      })
      .from(payrollAllocations)
      .where(
        and(
          eq(payrollAllocations.workspaceId, input.workspaceId),
          eq(payrollAllocations.payrollRunId, input.runId)
        )
      );
    const complete = allAllocations.every(
      (allocation) => allocation.claimAddress !== null
    );
    await tx
      .update(payrollRuns)
      .set({
        status: complete ? "committed" : "submitting",
        submissionSignature: input.signature,
        finalizedAt: complete ? now : null,
        updatedAt: now
      })
      .where(
        and(
          eq(payrollRuns.workspaceId, input.workspaceId),
          eq(payrollRuns.id, input.runId)
        )
      );

    await tx
      .insert(workspaceLedgerEntries)
      .values({
        workspaceId: input.workspaceId,
        idempotencyKey: `payroll-claim-commit:${input.runId}:${input.signature}`,
        category: "payroll",
        entryType: "claim_commitment",
        status: "finalized",
        referenceType: "payroll_run",
        referenceId: input.runId,
        transactionSignature: input.signature,
        metadata: {
          claimIds,
          claims: input.claims.map((claim) => ({
            claimId: claim.claimId,
            claimAddress: claim.claimAddress
          })),
          allocationCommitment: run.allocationCommitment,
          programId: input.programId,
          authorityAddress: input.authorityAddress,
          evidenceSource: "finalized_chain_verification"
        },
        createdAt: now
      })
      .onConflictDoNothing({
        target: [
          workspaceLedgerEntries.workspaceId,
          workspaceLedgerEntries.idempotencyKey
        ]
      });

    const financeMembers = await tx
      .select({ userId: workspaceMemberships.userId })
      .from(workspaceMemberships)
      .where(
        and(
          eq(workspaceMemberships.workspaceId, input.workspaceId),
          or(
            eq(workspaceMemberships.role, "organization_admin"),
            eq(workspaceMemberships.role, "finance_auditor")
          )
        )
      );
    await tx
      .insert(workspaceNotifications)
      .values(
        financeMembers.map((member) => ({
          workspaceId: input.workspaceId,
          recipientKey: member.userId,
          eventKey: `payroll-claim-commit:${input.runId}:${input.signature}`,
          category: "Payroll & Claims",
          title: complete
            ? "Payroll claim commitments finalized"
            : "Payroll claim commitments are being submitted",
          body: complete
            ? "All Claim PDAs for this payroll run are finalized on Devnet. Contributor settlement remains a separate step."
            : "A batch of Claim PDAs is finalized on Devnet. Additional payroll allocations still require submission.",
          destination: `/workspace/${input.workspaceId}/payroll/${input.runId}`,
          createdAt: now
        }))
      )
      .onConflictDoNothing({
        target: [
          workspaceNotifications.workspaceId,
          workspaceNotifications.eventKey,
          workspaceNotifications.recipientKey
        ]
      });

    return {
      status: complete ? ("committed" as const) : ("submitting" as const),
      submittedCount: rows.length,
      totalCount: allAllocations.length
    };
  });
}


async function hasActiveReserveConfidentialFunding(
  tx: Parameters<Parameters<Database["transaction"]>[0]>[0],
  workspaceId: string
): Promise<boolean> {
  const rows = await tx.select({ id: gasTankOperations.id })
    .from(gasTankOperations)
    .where(and(
      eq(gasTankOperations.workspaceId, workspaceId),
      eq(gasTankOperations.operationType, RESERVE_FUNDING_OPERATION_TYPE),
      inArray(gasTankOperations.status, ["preparing", "prepared"])
    ))
    .for("update")
    .limit(1);
  return rows.length > 0;
}

export async function beginPayrollSettlementAttempt(
  db: Database,
  input: {
    workspaceId: string;
    runId: string;
    allocationId: string;
    claimAddress: string;
    claimCreationSignature: string;
    sourceAvailableBefore: string;
    now?: Date;
  }
) {
  if (!/^(0|[1-9][0-9]*)$/.test(input.sourceAvailableBefore)) {
    throw new Error("The reserve's available confidential balance is invalid.");
  }
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const reserveRows = await tx.select({ workspaceId: workspaceReserves.workspaceId })
      .from(workspaceReserves).where(eq(workspaceReserves.workspaceId, input.workspaceId)).for("update").limit(1);
    if (!reserveRows[0]) return { status: "reserve_not_found" as const };
    if (await hasActiveReserveConfidentialFunding(tx, input.workspaceId)) {
      return { status: "workspace_busy" as const };
    }
    const rows = await tx.select({
      id: payrollAllocations.id,
      claimAddress: payrollAllocations.claimAddress,
      status: payrollAllocations.status,
      transactionSignature: payrollAllocations.transactionSignature,
      settlementSignature: payrollAllocations.settlementSignature,
      settlementSourceAvailableBefore: payrollAllocations.settlementSourceAvailableBefore
    }).from(payrollAllocations).where(and(
      eq(payrollAllocations.workspaceId, input.workspaceId),
      eq(payrollAllocations.payrollRunId, input.runId),
      eq(payrollAllocations.id, input.allocationId)
    )).for("update").limit(1);
    const allocation = rows[0];
    if (!allocation) return { status: "not_found" as const };

    if (
      allocation.status === "settlement_pending" &&
      allocation.claimAddress === input.claimAddress &&
      allocation.transactionSignature === input.claimCreationSignature &&
      allocation.settlementSourceAvailableBefore === input.sourceAvailableBefore
    ) return { status: "pending" as const, signature: allocation.settlementSignature };

    if (
      allocation.status !== "unclaimed" ||
      allocation.claimAddress !== input.claimAddress ||
      allocation.transactionSignature !== input.claimCreationSignature ||
      allocation.settlementSignature !== null
    ) return { status: "conflict" as const };

    const pendingRows = await tx.select({
      id: payrollAllocations.id
    }).from(payrollAllocations).where(and(
      eq(payrollAllocations.workspaceId, input.workspaceId),
      inArray(payrollAllocations.status, ["settlement_pending", "recovery_pending"])
    )).for("update").limit(1);
    if (pendingRows.length > 0) {
      return { status: "workspace_busy" as const };
    }

    const updated = await tx.update(payrollAllocations).set({
      status: "settlement_pending",
      settlementSignature: null,
      settlementSourceAvailableBefore: input.sourceAvailableBefore,
      settlementProofContextAddresses: [],
      settlementContextSignatures: [],
      updatedAt: now
    }).where(and(
      eq(payrollAllocations.id, input.allocationId),
      eq(payrollAllocations.workspaceId, input.workspaceId),
      eq(payrollAllocations.payrollRunId, input.runId),
      eq(payrollAllocations.status, "unclaimed"),
      eq(payrollAllocations.claimAddress, input.claimAddress),
      eq(payrollAllocations.transactionSignature, input.claimCreationSignature)
    )).returning({ id: payrollAllocations.id });
    return updated[0] ? { status: "started" as const } : { status: "conflict" as const };
  });
}

export async function attachPayrollSettlementSignature(
  db: Database,
  input: {
    workspaceId: string; runId: string; allocationId: string; claimAddress: string;
    claimCreationSignature: string; settlementSignature: string; sourceAvailableBefore: string;
    now?: Date;
  }
) {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const rows = await tx.select({
      id: payrollAllocations.id, status: payrollAllocations.status,
      claimAddress: payrollAllocations.claimAddress,
      transactionSignature: payrollAllocations.transactionSignature,
      settlementSignature: payrollAllocations.settlementSignature,
      settlementSourceAvailableBefore: payrollAllocations.settlementSourceAvailableBefore
    }).from(payrollAllocations).where(and(
      eq(payrollAllocations.workspaceId, input.workspaceId),
      eq(payrollAllocations.payrollRunId, input.runId),
      eq(payrollAllocations.id, input.allocationId)
    )).for("update").limit(1);
    const allocation = rows[0];
    if (!allocation) return { status: "not_found" as const };
    if (
      allocation.status === "settlement_pending" &&
      allocation.claimAddress === input.claimAddress &&
      allocation.transactionSignature === input.claimCreationSignature &&
      allocation.settlementSourceAvailableBefore === input.sourceAvailableBefore &&
      allocation.settlementSignature === input.settlementSignature
    ) return { status: "duplicate" as const };
    if (
      allocation.status !== "settlement_pending" ||
      allocation.claimAddress !== input.claimAddress ||
      allocation.transactionSignature !== input.claimCreationSignature ||
      allocation.settlementSourceAvailableBefore !== input.sourceAvailableBefore ||
      allocation.settlementSignature !== null
    ) return { status: "conflict" as const };
    const updated = await tx.update(payrollAllocations).set({
      settlementSignature: input.settlementSignature, updatedAt: now
    }).where(and(
      eq(payrollAllocations.id, input.allocationId),
      eq(payrollAllocations.workspaceId, input.workspaceId),
      eq(payrollAllocations.status, "settlement_pending"),
      isNull(payrollAllocations.settlementSignature)
    )).returning({ id: payrollAllocations.id });
    return updated[0] ? { status: "attached" as const } : { status: "conflict" as const };
  });
}

export async function releaseUnsubmittedPayrollSettlementAttempt(
  db: Database,
  input: { workspaceId: string; runId: string; allocationId: string; now?: Date }
) {
  const rows = await db.update(payrollAllocations).set({
    status: "unclaimed",
    settlementSignature: null,
    settlementSourceAvailableBefore: null,
    settlementProofContextAddresses: [],
    settlementContextSignatures: [],
    updatedAt: input.now ?? new Date()
  }).where(and(
    eq(payrollAllocations.id, input.allocationId),
    eq(payrollAllocations.workspaceId, input.workspaceId),
    eq(payrollAllocations.payrollRunId, input.runId),
    eq(payrollAllocations.status, "settlement_pending"),
    isNull(payrollAllocations.settlementSignature)
  )).returning({ id: payrollAllocations.id });
  return Boolean(rows[0]);
}

export async function setPayrollSettlementProofContexts(
  db: Database,
  input: { workspaceId: string; runId: string; allocationId: string; addresses: string[]; now?: Date }
) {
  if (
    input.addresses.length > 8 ||
    input.addresses.some((value) => typeof value !== "string" || value.length < 32 || value.length > 64) ||
    new Set(input.addresses).size !== input.addresses.length
  ) {
    throw new Error("The confidential proof-context address list is invalid.");
  }
  const rows = await db.update(payrollAllocations).set({
    settlementProofContextAddresses: input.addresses,
    updatedAt: input.now ?? new Date()
  }).where(and(
    eq(payrollAllocations.id, input.allocationId),
    eq(payrollAllocations.workspaceId, input.workspaceId),
    eq(payrollAllocations.payrollRunId, input.runId),
    eq(payrollAllocations.status, "settlement_pending")
  )).returning({ id: payrollAllocations.id });
  return Boolean(rows[0]);
}

export async function appendPayrollSettlementContextSignature(
  db: Database,
  input: { workspaceId: string; runId: string; allocationId: string; signature: string; now?: Date }
) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(input.signature)) {
    throw new Error("The confidential proof transaction signature is invalid.");
  }
  return db.transaction(async (tx) => {
    const rows = await tx.select({
      settlementContextSignatures: payrollAllocations.settlementContextSignatures
    }).from(payrollAllocations).where(and(
      eq(payrollAllocations.id, input.allocationId),
      eq(payrollAllocations.workspaceId, input.workspaceId),
      eq(payrollAllocations.payrollRunId, input.runId),
      eq(payrollAllocations.status, "settlement_pending")
    )).for("update").limit(1);
    if (!rows[0]) return false;
    const signatures = Array.isArray(rows[0].settlementContextSignatures)
      ? rows[0].settlementContextSignatures
      : [];
    if (signatures.includes(input.signature)) return true;
    const updated = await tx.update(payrollAllocations).set({
      settlementContextSignatures: [...signatures, input.signature],
      updatedAt: input.now ?? new Date()
    }).where(and(
      eq(payrollAllocations.id, input.allocationId),
      eq(payrollAllocations.workspaceId, input.workspaceId),
      eq(payrollAllocations.payrollRunId, input.runId),
      eq(payrollAllocations.status, "settlement_pending")
    )).returning({ id: payrollAllocations.id });
    return Boolean(updated[0]);
  });
}

export async function clearPayrollSettlementProofContexts(
  db: Database,
  input: { workspaceId: string; runId: string; allocationId: string; now?: Date }
) {
  const rows = await db.update(payrollAllocations).set({
    settlementProofContextAddresses: [],
    settlementContextSignatures: [],
    updatedAt: input.now ?? new Date()
  }).where(and(
    eq(payrollAllocations.id, input.allocationId),
    eq(payrollAllocations.workspaceId, input.workspaceId),
    eq(payrollAllocations.payrollRunId, input.runId),
    inArray(payrollAllocations.status, ["settlement_pending", "claimed"])
  )).returning({ id: payrollAllocations.id });
  return Boolean(rows[0]);
}

export async function updatePendingPayrollSettlementBalanceSnapshot(
  db: Database,
  input: { workspaceId: string; runId: string; allocationId: string; sourceAvailableBefore: string; now?: Date }
) {
  if (!/^(0|[1-9][0-9]*)$/.test(input.sourceAvailableBefore)) {
    throw new Error("The reserve's available confidential balance is invalid.");
  }
  const rows = await db.update(payrollAllocations).set({
    settlementSourceAvailableBefore: input.sourceAvailableBefore,
    updatedAt: input.now ?? new Date()
  }).where(and(
    eq(payrollAllocations.id, input.allocationId),
    eq(payrollAllocations.workspaceId, input.workspaceId),
    eq(payrollAllocations.payrollRunId, input.runId),
    eq(payrollAllocations.status, "settlement_pending"),
    isNull(payrollAllocations.settlementSignature)
  )).returning({ id: payrollAllocations.id });
  return Boolean(rows[0]);
}

export async function releaseFailedPayrollSettlementAttempt(
  db: Database,
  input: { workspaceId: string; runId: string; allocationId: string; settlementSignature: string; now?: Date }
) {
  const rows = await db.update(payrollAllocations).set({
    status: "unclaimed", settlementSignature: null, settlementSourceAvailableBefore: null,
    settlementProofContextAddresses: [], settlementContextSignatures: [], updatedAt: input.now ?? new Date()
  }).where(and(
    eq(payrollAllocations.id, input.allocationId),
    eq(payrollAllocations.workspaceId, input.workspaceId),
    eq(payrollAllocations.payrollRunId, input.runId),
    eq(payrollAllocations.status, "settlement_pending"),
    eq(payrollAllocations.settlementSignature, input.settlementSignature)
  )).returning({ id: payrollAllocations.id });
  return Boolean(rows[0]);
}

export async function getWorkspacePayrollProgramAuthority(
  db: Database,
  input: { workspaceId: string; programId: string }
): Promise<{ authorityAddress: string } | null> {
  const rows = await db.select({
    metadata: workspaceLedgerEntries.metadata
  }).from(workspaceLedgerEntries).where(and(
    eq(workspaceLedgerEntries.workspaceId, input.workspaceId),
    eq(workspaceLedgerEntries.entryType, "claim_commitment"),
    eq(workspaceLedgerEntries.referenceType, "payroll_run"),
    eq(workspaceLedgerEntries.status, "finalized")
  )).orderBy(desc(workspaceLedgerEntries.createdAt)).limit(100);
  for (const row of rows) {
    const metadata = row.metadata !== null && typeof row.metadata === "object" &&
      !Array.isArray(row.metadata) ? row.metadata as Record<string, unknown> : null;
    if (metadata?.programId === input.programId &&
        typeof metadata.authorityAddress === "string" &&
        metadata.authorityAddress.length > 0) {
      return { authorityAddress: metadata.authorityAddress };
    }
  }
  return null;
}

export async function getPayrollClaimCreationEvidence(
  db: Database,
  input: { workspaceId: string; runId: string; claimId: string; claimAddress: string }
) {
  const rows = await db.select({
    transactionSignature: workspaceLedgerEntries.transactionSignature,
    metadata: workspaceLedgerEntries.metadata,
    createdAt: workspaceLedgerEntries.createdAt
  }).from(workspaceLedgerEntries).where(and(
    eq(workspaceLedgerEntries.workspaceId, input.workspaceId),
    eq(workspaceLedgerEntries.entryType, "claim_commitment"),
    eq(workspaceLedgerEntries.referenceType, "payroll_run"),
    eq(workspaceLedgerEntries.referenceId, input.runId),
    eq(workspaceLedgerEntries.status, "finalized")
  )).orderBy(desc(workspaceLedgerEntries.createdAt)).limit(100);
  for (const row of rows) {
    const metadata = row.metadata !== null && typeof row.metadata === "object" && !Array.isArray(row.metadata)
      ? row.metadata as Record<string, unknown> : null;
    if (!metadata || typeof row.transactionSignature !== "string") continue;
    const claims = Array.isArray(metadata.claims) ? metadata.claims : [];
    const match = claims.some((claim) => claim !== null && typeof claim === "object" &&
      !Array.isArray(claim) &&
      (claim as Record<string, unknown>).claimId === input.claimId &&
      (claim as Record<string, unknown>).claimAddress === input.claimAddress);
    if (!match) continue;
    if (
      typeof metadata.programId !== "string" ||
      typeof metadata.authorityAddress !== "string" ||
      typeof metadata.allocationCommitment !== "string"
    ) throw new Error("The payroll Claim PDA creation evidence is incomplete.");
    return {
      transactionSignature: row.transactionSignature,
      programId: metadata.programId,
      authorityAddress: metadata.authorityAddress,
      allocationCommitment: metadata.allocationCommitment
    };
  }
  return null;
}

/** Records settlement only after a finalized transfer and the reserve's decrypted balance delta agree. */
export async function recordVerifiedPayrollClaimSettlement(
  db: Database,
  input: {
    workspaceId: string; runId: string; allocationId: string; contributorUserId: string;
    claimAddress: string; claimCreationSignature: string; settlementSignature: string;
    sourceTokenAccount: string; destinationTokenAccount: string; mint: string;
    programId: string; authorityAddress: string; sourceAvailableBefore: string;
    sourceAvailableAfter: string; now?: Date;
  }
) {
  if (!/^(0|[1-9][0-9]*)$/.test(input.sourceAvailableBefore) ||
      !/^(0|[1-9][0-9]*)$/.test(input.sourceAvailableAfter)) {
    throw new Error("The verified reserve balance evidence is invalid.");
  }
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const rows = await tx.select({
      id: payrollAllocations.id, amountBaseUnits: payrollAllocations.amountBaseUnits,
      claimId: payrollAllocations.claimId, claimAddress: payrollAllocations.claimAddress,
      status: payrollAllocations.status, transactionSignature: payrollAllocations.transactionSignature,
      settlementSignature: payrollAllocations.settlementSignature,
      settlementSourceAvailableBefore: payrollAllocations.settlementSourceAvailableBefore
    }).from(payrollAllocations).innerJoin(
      contributors, and(
        eq(contributors.id, payrollAllocations.contributorId),
        eq(contributors.workspaceId, payrollAllocations.workspaceId)
      )
    ).where(and(
      eq(payrollAllocations.id, input.allocationId),
      eq(payrollAllocations.workspaceId, input.workspaceId),
      eq(payrollAllocations.payrollRunId, input.runId)
    )).for("update").limit(1);
    const allocation = rows[0];
    if (!allocation) return { status: "not_found" as const };
    if (allocation.status === "claimed" && allocation.settlementSignature === input.settlementSignature) {
      return { status: "duplicate" as const };
    }
    if (
      allocation.status !== "settlement_pending" ||
      allocation.claimAddress !== input.claimAddress ||
      allocation.transactionSignature !== input.claimCreationSignature ||
      allocation.settlementSignature !== input.settlementSignature ||
      (allocation.settlementSourceAvailableBefore !== null &&
        allocation.settlementSourceAvailableBefore !== input.sourceAvailableBefore)
    ) return { status: "conflict" as const };
    const amount = BigInt(allocation.amountBaseUnits);
    const before = BigInt(input.sourceAvailableBefore);
    const after = BigInt(input.sourceAvailableAfter);
    if (before < after || before - after !== amount) return { status: "balance_mismatch" as const };

    const updated = await tx.update(payrollAllocations).set({
      status: "claimed", settlementSignature: input.settlementSignature,
      settlementSourceAvailableBefore: input.sourceAvailableBefore,
      claimedAt: now, updatedAt: now
    }).where(and(
      eq(payrollAllocations.id, input.allocationId),
      eq(payrollAllocations.workspaceId, input.workspaceId),
      eq(payrollAllocations.payrollRunId, input.runId),
      eq(payrollAllocations.status, "settlement_pending"),
      eq(payrollAllocations.settlementSignature, input.settlementSignature),
      eq(payrollAllocations.claimAddress, input.claimAddress),
      eq(payrollAllocations.transactionSignature, input.claimCreationSignature)
    )).returning({ id: payrollAllocations.id });
    if (!updated[0]) return { status: "conflict" as const };

    const ledgerKey = `payroll-settlement:${input.allocationId}`;
    const ledger = await tx.insert(workspaceLedgerEntries).values({
      workspaceId: input.workspaceId, idempotencyKey: ledgerKey,
      category: "payroll", entryType: "confidential_claim_settlement", status: "finalized",
      amountBaseUnits: allocation.amountBaseUnits, mint: input.mint,
      referenceType: "payroll_allocation", referenceId: input.allocationId,
      transactionSignature: input.settlementSignature,
      metadata: {
        runId: input.runId, claimId: allocation.claimId, claimAddress: input.claimAddress,
        claimCreationSignature: input.claimCreationSignature, programId: input.programId,
        authorityAddress: input.authorityAddress, sourceTokenAccount: input.sourceTokenAccount,
        destinationTokenAccount: input.destinationTokenAccount, balanceDeltaVerified: true,
        valueTransferred: true, sourceOfTruth: "finalized_solana_rpc_and_owner_decrypted_balance"
      }, createdAt: now
    }).onConflictDoNothing({
      target: [workspaceLedgerEntries.workspaceId, workspaceLedgerEntries.idempotencyKey]
    }).returning({ id: workspaceLedgerEntries.id });
    if (!ledger[0]) {
      const prior = await tx.select({ transactionSignature: workspaceLedgerEntries.transactionSignature })
        .from(workspaceLedgerEntries).where(and(
          eq(workspaceLedgerEntries.workspaceId, input.workspaceId),
          eq(workspaceLedgerEntries.idempotencyKey, ledgerKey)
        )).limit(1);
      if (prior[0]?.transactionSignature !== input.settlementSignature) {
        throw new Error("The payroll settlement ledger entry conflicts with finalized evidence.");
      }
    }
    await tx.insert(workspaceNotifications).values([{
      workspaceId: input.workspaceId, recipientKey: input.contributorUserId,
      eventKey: ledgerKey, category: "Payroll & Claims",
      title: "Confidential payroll claim settled",
      body: `Your confidential payroll allocation was transferred to your confidential account. Finalized transaction: ${input.settlementSignature}`,
      destination: `/workspace/${input.workspaceId}/compensation`, createdAt: now
    }]).onConflictDoNothing({
      target: [workspaceNotifications.workspaceId, workspaceNotifications.eventKey, workspaceNotifications.recipientKey]
    });
    const financeMembers = await tx.select({ userId: workspaceMemberships.userId })
      .from(workspaceMemberships).where(and(
        eq(workspaceMemberships.workspaceId, input.workspaceId),
        or(eq(workspaceMemberships.role, "organization_admin"), eq(workspaceMemberships.role, "finance_auditor"))
      ));
    if (financeMembers.length > 0) {
      await tx.insert(workspaceNotifications).values(financeMembers.map((member) => ({
        workspaceId: input.workspaceId, recipientKey: member.userId, eventKey: ledgerKey,
        category: "Payroll & Claims", title: "Confidential payroll settlement finalized",
        body: "A confidential payroll transfer and Claim PDA transition were verified at finality and reconciled to the reserve balance.",
        destination: `/workspace/${input.workspaceId}/ledger`, createdAt: now
      }))).onConflictDoNothing({
        target: [workspaceNotifications.workspaceId, workspaceNotifications.eventKey, workspaceNotifications.recipientKey]
      });
    }
    const outstanding = await tx.select({ id: payrollAllocations.id }).from(payrollAllocations)
      .where(and(
        eq(payrollAllocations.workspaceId, input.workspaceId),
        eq(payrollAllocations.payrollRunId, input.runId),
        notInArray(payrollAllocations.status, ["claimed", "recovered", "cancelled"])
      )).limit(1);
    if (!outstanding[0]) {
      await tx.update(payrollRuns).set({ status: "complete", finalizedAt: now, updatedAt: now })
        .where(and(eq(payrollRuns.workspaceId, input.workspaceId), eq(payrollRuns.id, input.runId)));
    }
    return {
      status: "claimed" as const, allocationId: input.allocationId,
      amountBaseUnits: allocation.amountBaseUnits, settlementSignature: input.settlementSignature
    };
  });
}

export async function recordPayrollRecovery(
  db: Database,
  input: {
    workspaceId: string;
    runId: string;
    allocationId: string;
    actorUserId: string;
    reason: string;
    reasonNote: string | null;
    signature: string;
    claimAddress: string;
    sourceAvailableBefore: string;
    sourceAvailableAfter: string;
    reserveAvailableBefore: string;
    reserveAvailableAfter: string;
    now?: Date;
  }
) {
  const balances = [
    input.sourceAvailableBefore,
    input.sourceAvailableAfter,
    input.reserveAvailableBefore,
    input.reserveAvailableAfter
  ];
  if (!balances.every((value) => /^(0|[1-9][0-9]*)$/.test(value))) {
    throw new Error("Finalized payroll recovery balance evidence is invalid.");
  }

  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const allocationRows = await tx
      .select({
        id: payrollAllocations.id,
        contributorId: payrollAllocations.contributorId,
        contributorWalletAddress: contributors.identityWalletAddress,
        amountBaseUnits: payrollAllocations.amountBaseUnits,
        claimId: payrollAllocations.claimId,
        claimAddress: payrollAllocations.claimAddress,
        status: payrollAllocations.status,
        transactionSignature: payrollAllocations.transactionSignature
      })
      .from(payrollAllocations)
      .innerJoin(
        contributors,
        and(
          eq(contributors.id, payrollAllocations.contributorId),
          eq(contributors.workspaceId, payrollAllocations.workspaceId)
        )
      )
      .where(and(
        eq(payrollAllocations.id, input.allocationId),
        eq(payrollAllocations.workspaceId, input.workspaceId),
        eq(payrollAllocations.payrollRunId, input.runId)
      ))
      .for("update")
      .limit(1);
    const allocation = allocationRows[0];
    if (!allocation) return { status: "not_found" as const };

    const escrowRows = await tx
      .select()
      .from(payrollClaimEscrows)
      .where(and(
        eq(payrollClaimEscrows.allocationId, input.allocationId),
        eq(payrollClaimEscrows.workspaceId, input.workspaceId),
        eq(payrollClaimEscrows.payrollRunId, input.runId)
      ))
      .for("update")
      .limit(1);
    const escrow = escrowRows[0];
    if (!escrow) return { status: "escrow_not_found" as const };

    const amount = BigInt(allocation.amountBaseUnits);
    const sourceBefore = BigInt(input.sourceAvailableBefore);
    const sourceAfter = BigInt(input.sourceAvailableAfter);
    const reserveBefore = BigInt(input.reserveAvailableBefore);
    const reserveAfter = BigInt(input.reserveAvailableAfter);
    if (
      sourceBefore < sourceAfter ||
      sourceBefore - sourceAfter !== amount ||
      reserveAfter < reserveBefore ||
      reserveAfter - reserveBefore !== amount
    ) return { status: "balance_mismatch" as const };

    const existingRows = await tx
      .select()
      .from(payrollRecoveries)
      .where(eq(payrollRecoveries.allocationId, input.allocationId))
      .limit(1);
    const existing = existingRows[0];
    if (existing) {
      if (
        allocation.status === "recovered" &&
        escrow.status === "recovered" &&
        escrow.recoverySignature === input.signature &&
        existing.status === "confirmed" &&
        existing.transactionSignature === input.signature &&
        existing.reason === input.reason &&
        existing.reasonNote === input.reasonNote
      ) return { status: "duplicate" as const };
      return { status: "conflict" as const };
    }

    if (
      allocation.status !== "recovery_pending" ||
      allocation.claimAddress !== input.claimAddress ||
      escrow.status !== "recovery_pending" ||
      escrow.recoverySignature !== input.signature
    ) return { status: "conflict" as const };

    const recoveryRows = await tx
      .insert(payrollRecoveries)
      .values({
        workspaceId: input.workspaceId,
        allocationId: input.allocationId,
        actorUserId: input.actorUserId,
        reason: input.reason,
        reasonNote: input.reasonNote,
        status: "confirmed",
        transactionSignature: input.signature,
        createdAt: now,
        confirmedAt: now
      })
      .onConflictDoNothing({ target: payrollRecoveries.allocationId })
      .returning({ id: payrollRecoveries.id });
    if (!recoveryRows[0]) return { status: "conflict" as const };

    const updatedAllocation = await tx
      .update(payrollAllocations)
      .set({
        status: "recovered",
        recoveredAt: now,
        transactionSignature: input.signature,
        updatedAt: now
      })
      .where(and(
        eq(payrollAllocations.id, input.allocationId),
        eq(payrollAllocations.workspaceId, input.workspaceId),
        eq(payrollAllocations.status, "recovery_pending"),
        eq(payrollAllocations.claimAddress, input.claimAddress)
      ))
      .returning({ id: payrollAllocations.id });
    if (!updatedAllocation[0]) {
      throw new Error("The payroll allocation changed during recovery reconciliation.");
    }

    const updatedEscrow = await tx
      .update(payrollClaimEscrows)
      .set({
        status: "recovered",
        recoverySourceAvailableBefore: input.sourceAvailableBefore,
        recoverySourceAvailableAfter: input.sourceAvailableAfter,
        recoveryDestinationAvailableBefore: input.reserveAvailableBefore,
        recoveryDestinationAvailableAfter: input.reserveAvailableAfter,
        recoveredAt: now,
        updatedAt: now
      })
      .where(and(
        eq(payrollClaimEscrows.allocationId, input.allocationId),
        eq(payrollClaimEscrows.workspaceId, input.workspaceId),
        eq(payrollClaimEscrows.status, "recovery_pending"),
        eq(payrollClaimEscrows.recoverySignature, input.signature)
      ))
      .returning({ allocationId: payrollClaimEscrows.allocationId });
    if (!updatedEscrow[0]) {
      throw new Error("The claim escrow changed during reserve restoration reconciliation.");
    }

    await tx
      .insert(workspaceLedgerEntries)
      .values({
        workspaceId: input.workspaceId,
        idempotencyKey: `payroll-recovery:${input.allocationId}`,
        category: "recovery",
        entryType: "confidential_claim_recovery",
        status: "finalized",
        amountBaseUnits: allocation.amountBaseUnits,
        referenceType: "payroll_allocation",
        referenceId: input.allocationId,
        transactionSignature: input.signature,
        metadata: {
          runId: input.runId,
          claimId: allocation.claimId,
          reason: input.reason,
          restoredReserveBaseUnits: allocation.amountBaseUnits,
          escrowTokenAccount: escrow.tokenAccountAddress,
          confidentialSourceAvailableBefore: input.sourceAvailableBefore,
          confidentialSourceAvailableAfter: input.sourceAvailableAfter,
          reserveAvailableBefore: input.reserveAvailableBefore,
          reserveAvailableAfter: input.reserveAvailableAfter,
          balanceDeltaVerified: true,
          valueTransferred: true,
          sourceOfTruth: "finalized_solana_rpc_and_owner_decrypted_confidential_balances"
        },
        createdAt: now
      })
      .onConflictDoNothing({
        target: [
          workspaceLedgerEntries.workspaceId,
          workspaceLedgerEntries.idempotencyKey
        ]
      });

    const contributorUsers = await tx
      .select({ userId: walletIdentities.userId })
      .from(walletIdentities)
      .where(eq(walletIdentities.address, allocation.contributorWalletAddress));
    await tx
      .insert(workspaceNotifications)
      .values(contributorUsers.map((contributor) => ({
        workspaceId: input.workspaceId,
        recipientKey: contributor.userId,
        eventKey: `payroll-recovery:${input.allocationId}`,
        category: "Recovery & Offboarding",
        title: "Unclaimed payroll restored to the reserve",
        body: `The unclaimed payroll allocation was restored to the workspace's confidential reserve. Finalized transaction: ${input.signature}`,
        destination: `/workspace/${input.workspaceId}/compensation`,
        createdAt: now
      })))
      .onConflictDoNothing({
        target: [
          workspaceNotifications.workspaceId,
          workspaceNotifications.eventKey,
          workspaceNotifications.recipientKey
        ]
      });

    const financeMembers = await tx
      .select({ userId: workspaceMemberships.userId })
      .from(workspaceMemberships)
      .where(and(
        eq(workspaceMemberships.workspaceId, input.workspaceId),
        or(
          eq(workspaceMemberships.role, "organization_admin"),
          eq(workspaceMemberships.role, "finance_auditor")
        )
      ));
    await tx
      .insert(workspaceNotifications)
      .values(financeMembers.map((member) => ({
        workspaceId: input.workspaceId,
        recipientKey: member.userId,
        eventKey: `payroll-recovery:${input.allocationId}`,
        category: "Recovery & Offboarding",
        title: "Confidential payroll recovery finalized",
        body: "The Claim PDA transition and confidential reserve restoration were verified at finality and reconciled to both account balances.",
        destination: `/workspace/${input.workspaceId}/ledger`,
        createdAt: now
      })))
      .onConflictDoNothing({
        target: [
          workspaceNotifications.workspaceId,
          workspaceNotifications.eventKey,
          workspaceNotifications.recipientKey
        ]
      });

    return { status: "recovered" as const };
  });
}

export async function createPayrollDraft(
  db: Database,
  input: {
    workspaceId: string;
    createdByUserId: string;
    idempotencyKey: string;
    importDigest: string;
    allocationCommitment: string;
    totalAmountBaseUnits: string;
    allocations: Array<{
      contributorId: string;
      amountBaseUnits: string;
      amountCommitment: string;
      amountCommitmentProof: string[];
      amountCommitmentLeafIndex: number;
      claimId: string;
    }>;
  }
) {
  return db.transaction(async (tx) => {
    const deletion = await tx
      .select({
        deletionScheduledAt: workspaceRetention.deletionScheduledAt,
        deletionCanceledAt: workspaceRetention.deletionCanceledAt
      })
      .from(workspaceRetention)
      .where(eq(workspaceRetention.workspaceId, input.workspaceId))
      .for("update")
      .limit(1);
    if (
      deletion[0]?.deletionScheduledAt &&
      !deletion[0].deletionCanceledAt
    ) {
      throw new Error("WORKSPACE_DELETION_PENDING");
    }

    const inserted = await tx
      .insert(payrollRuns)
      .values({
        workspaceId: input.workspaceId,
        createdByUserId: input.createdByUserId,
        idempotencyKey: input.idempotencyKey,
        importDigest: input.importDigest,
        allocationCommitment: input.allocationCommitment,
        totalAmountBaseUnits: input.totalAmountBaseUnits,
        status: "commit_pending",
        managerConfirmedAt: new Date()
      })
      .onConflictDoNothing({
        target: [payrollRuns.workspaceId, payrollRuns.idempotencyKey]
      })
      .returning();
    const run = inserted[0];
    if (!run) {
      const existing = await tx
        .select()
        .from(payrollRuns)
        .where(
          and(
            eq(payrollRuns.workspaceId, input.workspaceId),
            eq(payrollRuns.idempotencyKey, input.idempotencyKey)
          )
        )
        .limit(1);
      if (!existing[0] || existing[0].importDigest !== input.importDigest) {
        throw new Error("Payroll idempotency key conflicts with another import.");
      }
      const savedAllocations = await tx
        .select()
        .from(payrollAllocations)
        .where(
          and(
            eq(payrollAllocations.workspaceId, input.workspaceId),
            eq(payrollAllocations.payrollRunId, existing[0].id)
          )
        )
        .orderBy(asc(payrollAllocations.createdAt));
      return {
        run: existing[0],
        allocations: savedAllocations,
        created: false
      };
    }

    const contributorIds = [
      ...new Set(input.allocations.map((allocation) => allocation.contributorId))
    ];
    const activeContributors = contributorIds.length
      ? await tx
          .select({
            id: contributors.id,
            lifecycle: contributors.lifecycle,
            role: contributors.role
          })
          .from(contributors)
          .where(
            and(
              eq(contributors.workspaceId, input.workspaceId),
              inArray(contributors.id, contributorIds)
            )
          )
          .orderBy(asc(contributors.id))
          .for("update")
      : [];
    if (
      activeContributors.length !== contributorIds.length ||
      activeContributors.some(
        (contributor) =>
          contributor.lifecycle !== "active" ||
          contributor.role !== "contributor"
      )
    ) {
      throw new Error("PAYROLL_CONTRIBUTOR_NOT_ACTIVE");
    }

    const savedAllocations = await tx
      .insert(payrollAllocations)
      .values(
        input.allocations.map((allocation) => ({
          workspaceId: input.workspaceId,
          payrollRunId: run.id,
          contributorId: allocation.contributorId,
          amountBaseUnits: allocation.amountBaseUnits,
          amountCommitment: allocation.amountCommitment,
          amountCommitmentProof: allocation.amountCommitmentProof,
          amountCommitmentLeafIndex: allocation.amountCommitmentLeafIndex,
          claimId: allocation.claimId,
          status: "draft"
        }))
      )
      .returning();
    return { run, allocations: savedAllocations, created: true };
  });
}

export async function cancelPayrollDraft(
  db: Database,
  workspaceId: string,
  runId: string,
  now = new Date()
) {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        status: payrollRuns.status,
        submissionSignature: payrollRuns.submissionSignature
      })
      .from(payrollRuns)
      .where(
        and(
          eq(payrollRuns.workspaceId, workspaceId),
          eq(payrollRuns.id, runId)
        )
      )
      .for("update")
      .limit(1);
    const run = rows[0];
    if (!run) return { status: "not_found" as const };
    if (run.status !== "commit_pending" || run.submissionSignature) {
      return { status: "commitment_started" as const };
    }

    const allocations = await tx
      .select({
        claimAddress: payrollAllocations.claimAddress,
        transactionSignature: payrollAllocations.transactionSignature
      })
      .from(payrollAllocations)
      .where(
        and(
          eq(payrollAllocations.workspaceId, workspaceId),
          eq(payrollAllocations.payrollRunId, runId)
        )
      )
      .for("update");
    if (
      allocations.some(
        (allocation) =>
          allocation.claimAddress !== null ||
          allocation.transactionSignature !== null
      )
    ) {
      return { status: "commitment_started" as const };
    }

    const cancelled = await tx
      .update(payrollRuns)
      .set({ status: "cancelled", updatedAt: now })
      .where(
        and(
          eq(payrollRuns.workspaceId, workspaceId),
          eq(payrollRuns.id, runId),
          eq(payrollRuns.status, "commit_pending"),
          isNull(payrollRuns.submissionSignature)
        )
      )
      .returning({ id: payrollRuns.id });
    if (!cancelled[0]) {
      return { status: "commitment_started" as const };
    }

    await tx
      .update(payrollAllocations)
      .set({ status: "cancelled", updatedAt: now })
      .where(
        and(
          eq(payrollAllocations.workspaceId, workspaceId),
          eq(payrollAllocations.payrollRunId, runId),
          isNull(payrollAllocations.claimAddress),
          isNull(payrollAllocations.transactionSignature)
        )
      );
    return { status: "cancelled" as const, runId };
  });
}

export async function getSubscriptionPaymentAttemptBySignature(
  db: Database,
  signature: string
) {
  const rows = await db
    .select()
    .from(subscriptionPaymentAttempts)
    .where(eq(subscriptionPaymentAttempts.signature, signature))
    .limit(1);
  return rows[0] ?? null;
}

export async function getPayrollAllocationForChainReconciliation(
  db: Database,
  claimAddress: string
) {
  const rows = await db
    .select({
      workspaceId: payrollAllocations.workspaceId,
      runId: payrollAllocations.payrollRunId,
      allocationId: payrollAllocations.id,
      claimId: payrollAllocations.claimId,
      claimAddress: payrollAllocations.claimAddress,
      allocationStatus: payrollAllocations.status,
      transactionSignature: payrollAllocations.transactionSignature,
      settlementSignature: payrollAllocations.settlementSignature,
      amountBaseUnits: payrollAllocations.amountBaseUnits,
      contributorWalletAddress: contributors.identityWalletAddress,
      allocationCommitment: payrollRuns.allocationCommitment,
      amountCommitment: payrollAllocations.amountCommitment,
      recoveryStatus: payrollRecoveries.status,
      recoverySignature: payrollRecoveries.transactionSignature,
      recoveryReason: payrollRecoveries.reason,
      recoveryReasonNote: payrollRecoveries.reasonNote
    })
    .from(payrollAllocations)
    .innerJoin(
      payrollRuns,
      and(
        eq(payrollRuns.id, payrollAllocations.payrollRunId),
        eq(payrollRuns.workspaceId, payrollAllocations.workspaceId)
      )
    )
    .innerJoin(
      contributors,
      and(
        eq(contributors.id, payrollAllocations.contributorId),
        eq(contributors.workspaceId, payrollAllocations.workspaceId)
      )
    )
    .leftJoin(
      payrollRecoveries,
      eq(payrollRecoveries.allocationId, payrollAllocations.id)
    )
    .where(eq(payrollAllocations.claimAddress, claimAddress))
    .limit(2);
  if (rows.length > 1) {
    throw new Error("The Claim PDA address maps to more than one application allocation.");
  }
  return rows[0] ?? null;
}


/** Records a finalized Claim PDA transition only after its confidential settlement ledger is already reconciled. */

export type WorkspaceNonFinancialOutcomeInput = {
  workspaceId: string;
  idempotencyKey: string;
  category: "billing" | "payroll" | "recovery" | "gas_operations" | "cash_out";
  entryType: string;
  status: "pending" | "failed" | "reversed";
  referenceType?: string | null;
  referenceId?: string | null;
  transactionSignature?: string | null;
  metadata: Record<string, string | number | boolean | null>;
  now?: Date;
};

/** Records an operational outcome without assigning an unverified financial amount. */
export async function recordWorkspaceNonFinancialOutcome(
  db: Database,
  input: WorkspaceNonFinancialOutcomeInput
) {
  if (!/^[A-Za-z0-9][A-Za-z0-9:_-]{0,199}$/.test(input.idempotencyKey) ||
      !/^[a-z][a-z0-9_]{0,79}$/.test(input.entryType) ||
      !/^[a-z0-9_]{1,40}$/.test(input.category) ||
      Object.keys(input.metadata).some((key) => /ciphertext|private.?key|secret|amountBaseUnits/i.test(key))) {
    throw new Error("The non-financial ledger outcome is invalid.");
  }
  const now = input.now ?? new Date();
  const metadata = {
    ...input.metadata,
    financialValueVerified: false,
    amountOmittedReason: "non_financial_outcome"
  };
  return db.transaction(async (tx) => {
    const inserted = await tx.insert(workspaceLedgerEntries).values({
      workspaceId: input.workspaceId,
      idempotencyKey: input.idempotencyKey,
      category: input.category,
      entryType: input.entryType,
      status: input.status,
      amountBaseUnits: null,
      mint: null,
      referenceType: input.referenceType ?? null,
      referenceId: input.referenceId ?? null,
      transactionSignature: input.transactionSignature ?? null,
      metadata,
      createdAt: now
    }).onConflictDoNothing({
      target: [workspaceLedgerEntries.workspaceId, workspaceLedgerEntries.idempotencyKey]
    }).returning({ id: workspaceLedgerEntries.id });
    if (inserted[0]) return { status: "recorded" as const };

    const existingRows = await tx.select({
      category: workspaceLedgerEntries.category,
      entryType: workspaceLedgerEntries.entryType,
      status: workspaceLedgerEntries.status,
      referenceType: workspaceLedgerEntries.referenceType,
      referenceId: workspaceLedgerEntries.referenceId,
      transactionSignature: workspaceLedgerEntries.transactionSignature,
      metadata: workspaceLedgerEntries.metadata
    }).from(workspaceLedgerEntries).where(and(
      eq(workspaceLedgerEntries.workspaceId, input.workspaceId),
      eq(workspaceLedgerEntries.idempotencyKey, input.idempotencyKey)
    )).limit(1);
    const existing = existingRows[0];
    const existingMetadata = existing?.metadata !== null &&
      typeof existing?.metadata === "object" && !Array.isArray(existing.metadata)
      ? existing.metadata as Record<string, unknown> : null;
    const replayMatches = existing?.category === input.category &&
      existing.entryType === input.entryType &&
      existing.status === input.status &&
      existing.referenceType === (input.referenceType ?? null) &&
      existing.referenceId === (input.referenceId ?? null) &&
      existing.transactionSignature === (input.transactionSignature ?? null) &&
      existingMetadata?.outcome === (input.metadata.outcome ?? null) &&
      existingMetadata?.errorCode === (input.metadata.errorCode ?? null);
    return replayMatches ? { status: "duplicate" as const } : { status: "conflict" as const };
  });
}

export async function recordVerifiedPublicCashOutLedger(
  db: Database,
  input: {
    workspaceId: string;
    contributorId: string;
    contributorWalletAddress: string;
    kind: "confidential_withdrawal" | "circle_usdc_unwrap";
    signature: string;
    amountBaseUnits: string;
    mint: string;
    sourceTokenAccount: string;
    destinationTokenAccount: string;
    now?: Date;
  }
) {
  if (!/^[1-9][0-9]{0,19}$/.test(input.amountBaseUnits) ||
      BigInt(input.amountBaseUnits) >= (1n << 64n) ||
      !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(input.signature) ||
      !input.mint || !input.sourceTokenAccount || !input.destinationTokenAccount ||
      !input.contributorWalletAddress) {
    throw new Error("The verified public cash-out ledger input is invalid.");
  }
  const now = input.now ?? new Date();
  const entryType = input.kind === "confidential_withdrawal"
    ? "confidential_balance_withdrawal"
    : "circle_usdc_unwrap";
  const idempotencyKey = `public-cash-out:${input.kind}:${input.signature}`;

  return db.transaction(async (tx) => {
    const contributorRows = await tx.select({
      id: contributors.id,
      identityWalletAddress: contributors.identityWalletAddress,
      lifecycle: contributors.lifecycle
    }).from(contributors).where(and(
      eq(contributors.workspaceId, input.workspaceId),
      eq(contributors.id, input.contributorId)
    )).for("update").limit(1);
    const contributor = contributorRows[0];
    if (!contributor || contributor.lifecycle === "left" ||
        contributor.identityWalletAddress !== input.contributorWalletAddress) {
      return { status: "not_found" as const };
    }

    const metadata = {
      contributorWalletAddress: input.contributorWalletAddress,
      sourceTokenAccount: input.sourceTokenAccount,
      destinationTokenAccount: input.destinationTokenAccount,
      balanceDeltaVerified: true,
      valueTransferred: true,
      sourceOfTruth: "finalized_solana_transaction_and_exact_public_token_balance_delta"
    };
    const inserted = await tx.insert(workspaceLedgerEntries).values({
      workspaceId: input.workspaceId,
      idempotencyKey,
      category: "cash_out",
      entryType,
      status: "finalized",
      amountBaseUnits: input.amountBaseUnits,
      mint: input.mint,
      referenceType: "contributor",
      referenceId: input.contributorId,
      transactionSignature: input.signature,
      metadata,
      createdAt: now
    }).onConflictDoNothing({
      target: [workspaceLedgerEntries.workspaceId, workspaceLedgerEntries.idempotencyKey]
    }).returning({ id: workspaceLedgerEntries.id });
    let status: "finalized" | "duplicate";
    if (inserted[0]) {
      status = "finalized";
    } else {
      const existingRows = await tx.select({
        entryType: workspaceLedgerEntries.entryType,
        status: workspaceLedgerEntries.status,
        amountBaseUnits: workspaceLedgerEntries.amountBaseUnits,
        mint: workspaceLedgerEntries.mint,
        referenceType: workspaceLedgerEntries.referenceType,
        referenceId: workspaceLedgerEntries.referenceId,
        transactionSignature: workspaceLedgerEntries.transactionSignature,
        metadata: workspaceLedgerEntries.metadata
      }).from(workspaceLedgerEntries).where(and(
        eq(workspaceLedgerEntries.workspaceId, input.workspaceId),
        eq(workspaceLedgerEntries.idempotencyKey, idempotencyKey)
      )).limit(1);
      const existing = existingRows[0];
      const existingMetadata = existing?.metadata !== null &&
        typeof existing?.metadata === "object" && !Array.isArray(existing.metadata)
        ? existing.metadata as Record<string, unknown> : null;
      const sameEvidence = existing?.entryType === entryType &&
        existing.status === "finalized" &&
        existing.amountBaseUnits === input.amountBaseUnits &&
        existing.mint === input.mint &&
        existing.referenceType === "contributor" &&
        existing.referenceId === input.contributorId &&
        existing.transactionSignature === input.signature &&
        existingMetadata?.contributorWalletAddress === input.contributorWalletAddress &&
        existingMetadata?.sourceTokenAccount === input.sourceTokenAccount &&
        existingMetadata?.destinationTokenAccount === input.destinationTokenAccount &&
        existingMetadata?.balanceDeltaVerified === true &&
        existingMetadata?.valueTransferred === true;
      if (!sameEvidence) return { status: "conflict" as const };
      status = "duplicate";
    }

    const contributorUsers = await tx.select({
      userId: walletIdentities.userId
    }).from(walletIdentities).where(
      eq(walletIdentities.address, input.contributorWalletAddress)
    );
    if (contributorUsers.length > 0) {
      await tx.insert(workspaceNotifications).values(contributorUsers.map((user) => ({
        workspaceId: input.workspaceId,
        recipientKey: user.userId,
        eventKey: idempotencyKey,
        category: "Payroll & Claims",
        title: input.kind === "confidential_withdrawal"
          ? "Token withdrawal finalized"
          : "USDC unwrap finalized",
        body: "Your public token withdrawal was verified at finality and the exact token balance change was reconciled.",
        destination: `/workspace/${input.workspaceId}/compensation`,
        createdAt: now
      }))).onConflictDoNothing({
        target: [
          workspaceNotifications.workspaceId,
          workspaceNotifications.eventKey,
          workspaceNotifications.recipientKey
        ]
      });
    }

    const financeMembers = await tx.select({
      userId: workspaceMemberships.userId
    }).from(workspaceMemberships).where(and(
      eq(workspaceMemberships.workspaceId, input.workspaceId),
      or(
        eq(workspaceMemberships.role, "organization_admin"),
        eq(workspaceMemberships.role, "finance_auditor")
      )
    ));
    if (financeMembers.length > 0) {
      await tx.insert(workspaceNotifications).values(financeMembers.map((member) => ({
        workspaceId: input.workspaceId,
        recipientKey: member.userId,
        eventKey: idempotencyKey,
        category: "Payroll & Claims",
        title: input.kind === "confidential_withdrawal"
          ? "Contributor token withdrawal finalized"
          : "Contributor USDC unwrap finalized",
        body: "A contributor token withdrawal was verified at finality and reconciled to an exact public token balance change.",
        destination: `/workspace/${input.workspaceId}/ledger`,
        createdAt: now
      }))).onConflictDoNothing({
        target: [
          workspaceNotifications.workspaceId,
          workspaceNotifications.eventKey,
          workspaceNotifications.recipientKey
        ]
      });
    }
    return { status };
  });
}

export async function recordVerifiedPayrollClaimFinalizationEvent(
  db: Database,
  input: {
    workspaceId: string;
    runId: string;
    allocationId: string;
    claimAddress: string;
    claimCreationSignature: string;
    settlementSignature: string;
    authorityAddress: string;
    signature: string;
    now?: Date;
  }
) {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const rows = await tx.select({
      id: payrollAllocations.id,
      workspaceId: payrollAllocations.workspaceId,
      payrollRunId: payrollAllocations.payrollRunId,
      status: payrollAllocations.status,
      claimAddress: payrollAllocations.claimAddress,
      transactionSignature: payrollAllocations.transactionSignature,
      settlementSignature: payrollAllocations.settlementSignature,
      contributorUserId: walletIdentities.userId
    }).from(payrollAllocations).innerJoin(
      contributors,
      and(
        eq(contributors.id, payrollAllocations.contributorId),
        eq(contributors.workspaceId, payrollAllocations.workspaceId)
      )
    ).leftJoin(
      walletIdentities,
      eq(walletIdentities.address, contributors.identityWalletAddress)
    ).where(and(
      eq(payrollAllocations.id, input.allocationId),
      eq(payrollAllocations.workspaceId, input.workspaceId),
      eq(payrollAllocations.payrollRunId, input.runId)
    )).for("update").limit(1);
    const allocation = rows[0];
    if (!allocation || allocation.claimAddress !== input.claimAddress ||
        allocation.transactionSignature !== input.claimCreationSignature ||
        allocation.settlementSignature !== input.settlementSignature ||
        allocation.status !== "claimed") {
      return { status: "not_reconciled" as const };
    }

    const settlementLedger = await tx.select({
      status: workspaceLedgerEntries.status,
      transactionSignature: workspaceLedgerEntries.transactionSignature
    }).from(workspaceLedgerEntries).where(and(
      eq(workspaceLedgerEntries.workspaceId, input.workspaceId),
      eq(workspaceLedgerEntries.idempotencyKey, `payroll-settlement:${input.allocationId}`)
    )).limit(1);
    if (!settlementLedger[0] || settlementLedger[0].status !== "finalized" ||
        settlementLedger[0].transactionSignature !== input.settlementSignature) {
      return { status: "not_reconciled" as const };
    }

    const key = `payroll-claim-finalization:${input.allocationId}`;
    const inserted = await tx.insert(workspaceLedgerEntries).values({
      workspaceId: input.workspaceId,
      idempotencyKey: key,
      category: "payroll",
      entryType: "claim_finalized",
      status: "finalized",
      amountBaseUnits: null,
      mint: null,
      referenceType: "payroll_allocation",
      referenceId: input.allocationId,
      transactionSignature: input.signature,
      metadata: {
        runId: input.runId,
        claimAddress: input.claimAddress,
        claimCreationSignature: input.claimCreationSignature,
        settlementSignature: input.settlementSignature,
        authorityAddress: input.authorityAddress,
        valueTransferred: false,
        source: "finalized_claim_pda_and_existing_settlement_ledger"
      },
      createdAt: now
    }).onConflictDoNothing({
      target: [workspaceLedgerEntries.workspaceId, workspaceLedgerEntries.idempotencyKey]
    }).returning({ id: workspaceLedgerEntries.id });
    let status: "finalized" | "duplicate";
    if (inserted[0]) {
      status = "finalized";
    } else {
      const existing = await tx.select({
        status: workspaceLedgerEntries.status,
        transactionSignature: workspaceLedgerEntries.transactionSignature
      }).from(workspaceLedgerEntries).where(and(
        eq(workspaceLedgerEntries.workspaceId, input.workspaceId),
        eq(workspaceLedgerEntries.idempotencyKey, key)
      )).limit(1);
      if (existing[0]?.status !== "finalized" ||
          existing[0].transactionSignature !== input.signature) {
        return { status: "conflict" as const };
      }
      status = "duplicate";
    }

    // Replays repair missing notification rows without creating duplicates.
    if (allocation.contributorUserId) {
      await tx.insert(workspaceNotifications).values({
        workspaceId: input.workspaceId,
        recipientKey: allocation.contributorUserId,
        eventKey: key,
        category: "Payroll & Claims",
        title: "Payroll claim finalized",
        body: "The on-chain Claim PDA finalization was verified against your finalized payroll settlement. This state transition did not move additional funds.",
        destination: `/workspace/${input.workspaceId}/compensation`,
        createdAt: now
      }).onConflictDoNothing({
        target: [
          workspaceNotifications.workspaceId,
          workspaceNotifications.eventKey,
          workspaceNotifications.recipientKey
        ]
      });
    }
    const financeMembers = await tx.select({
      userId: workspaceMemberships.userId
    }).from(workspaceMemberships).where(and(
      eq(workspaceMemberships.workspaceId, input.workspaceId),
      or(
        eq(workspaceMemberships.role, "organization_admin"),
        eq(workspaceMemberships.role, "finance_auditor")
      )
    ));
    if (financeMembers.length > 0) {
      await tx.insert(workspaceNotifications).values(financeMembers.map((member) => ({
        workspaceId: input.workspaceId,
        recipientKey: member.userId,
        eventKey: key,
        category: "Payroll & Claims",
        title: "Payroll claim finalization verified",
        body: "The Claim PDA state transition was verified at finality and linked to its finalized settlement ledger entry.",
        destination: `/workspace/${input.workspaceId}/ledger`,
        createdAt: now
      }))).onConflictDoNothing({
        target: [
          workspaceNotifications.workspaceId,
          workspaceNotifications.eventKey,
          workspaceNotifications.recipientKey
        ]
      });
    }
    return { status };
  });
}

export async function recordVerifiedPayrollRecoveryEvent(
  db: Database,
  input: {
    workspaceId: string;
    runId: string;
    allocationId: string;
    signature: string;
    claimAddress: string;
    now?: Date;
  }
) {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: payrollAllocations.id,
        claimAddress: payrollAllocations.claimAddress,
        status: payrollAllocations.status,
        transactionSignature: payrollAllocations.transactionSignature,
        claimId: payrollAllocations.claimId
      })
      .from(payrollAllocations)
      .where(and(
        eq(payrollAllocations.id, input.allocationId),
        eq(payrollAllocations.workspaceId, input.workspaceId),
        eq(payrollAllocations.payrollRunId, input.runId)
      ))
      .for("update")
      .limit(1);
    const allocation = rows[0];
    if (!allocation) return { status: "not_found" as const };
    if (allocation.status === "recovered" &&
        allocation.claimAddress === input.claimAddress &&
        allocation.transactionSignature === input.signature) {
      return { status: "duplicate" as const };
    }
    if (allocation.status !== "unclaimed" ||
        allocation.claimAddress !== input.claimAddress) {
      return { status: "conflict" as const };
    }
    const updated = await tx.update(payrollAllocations).set({
      status: "recovered",
      recoveredAt: now,
      transactionSignature: input.signature,
      updatedAt: now
    }).where(and(
      eq(payrollAllocations.id, input.allocationId),
      eq(payrollAllocations.workspaceId, input.workspaceId),
      eq(payrollAllocations.status, "unclaimed"),
      eq(payrollAllocations.claimAddress, input.claimAddress)
    )).returning({ id: payrollAllocations.id });
    if (!updated[0]) return { status: "conflict" as const };
    await tx.insert(workspaceLedgerEntries).values({
      workspaceId: input.workspaceId,
      idempotencyKey: `payroll-recovery-chain:${input.allocationId}`,
      category: "recovery",
      entryType: "claim_entitlement_cancelled",
      status: "finalized",
      referenceType: "payroll_allocation",
      referenceId: input.allocationId,
      transactionSignature: input.signature,
      metadata: {
        runId: input.runId,
        claimId: allocation.claimId,
        claimAddress: input.claimAddress,
        valueTransferred: false,
        source: "finalized_chain_event"
      },
      createdAt: now
    }).onConflictDoNothing({
      target: [workspaceLedgerEntries.workspaceId, workspaceLedgerEntries.idempotencyKey]
    });
    return { status: "recovered" as const };
  });
}

export async function getPayrollAllocationsForChainReconciliationByClaimIds(
  db: Database,
  claimIds: string[]
) {
  if (claimIds.length === 0 || new Set(claimIds).size !== claimIds.length) {
    return [];
  }
  return db
    .select({
      workspaceId: payrollAllocations.workspaceId,
      runId: payrollAllocations.payrollRunId,
      allocationId: payrollAllocations.id,
      claimId: payrollAllocations.claimId,
      claimAddress: payrollAllocations.claimAddress,
      allocationStatus: payrollAllocations.status,
      contributorWalletAddress: contributors.identityWalletAddress,
      allocationCommitment: payrollRuns.allocationCommitment
    })
    .from(payrollAllocations)
    .innerJoin(
      payrollRuns,
      and(
        eq(payrollRuns.id, payrollAllocations.payrollRunId),
        eq(payrollRuns.workspaceId, payrollAllocations.workspaceId)
      )
    )
    .innerJoin(
      contributors,
      and(
        eq(contributors.id, payrollAllocations.contributorId),
        eq(contributors.workspaceId, payrollAllocations.workspaceId)
      )
    )
    .where(inArray(payrollAllocations.claimId, claimIds));
}

export async function getWorkspaceGasTankByAddress(
  db: Database,
  address: string
) {
  const rows = await db
    .select({
      workspaceId: workspaceGasTanks.workspaceId,
      address: workspaceGasTanks.address
    })
    .from(workspaceGasTanks)
    .where(eq(workspaceGasTanks.address, address))
    .limit(2);
  if (rows.length > 1) {
    throw new Error("A Gas Tank address maps to multiple workspaces.");
  }
  return rows[0] ?? null;
}

export async function recordVerifiedGasTankFundingEvent(
  db: Database,
  input: {
    workspaceId: string;
    destination: string;
    source: string;
    signature: string;
    amountLamports: string;
    confirmedBalanceLamports: string;
    now?: Date;
  }
) {
  if (!/^[1-9][0-9]*$/.test(input.amountLamports) ||
      !/^(0|[1-9][0-9]*)$/.test(input.confirmedBalanceLamports) ||
      BigInt(input.amountLamports) >= (1n << 64n) ||
      BigInt(input.confirmedBalanceLamports) >= (1n << 64n)) {
    throw new Error("Invalid finalized Gas Tank balance or funding amount.");
  }
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const tanks = await tx
      .select({
        workspaceId: workspaceGasTanks.workspaceId,
        address: workspaceGasTanks.address
      })
      .from(workspaceGasTanks)
      .where(and(
        eq(workspaceGasTanks.workspaceId, input.workspaceId),
        eq(workspaceGasTanks.address, input.destination)
      ))
      .for("update")
      .limit(1);
    if (!tanks[0]) return { status: "not_found" as const };
    const entries = await tx
      .insert(workspaceLedgerEntries)
      .values({
        workspaceId: input.workspaceId,
        idempotencyKey: "gas-tank-funding:" + input.signature,
        category: "gas_operations",
        entryType: "gas_tank_funding",
        status: "finalized",
        amountBaseUnits: input.amountLamports,
        referenceType: "gas_tank",
        referenceId: input.workspaceId,
        transactionSignature: input.signature,
        metadata: {
          asset: "SOL",
          source: input.source,
          destination: input.destination,
          amountLamports: input.amountLamports,
          valueTransferred: true,
          sourceOfTruth: "finalized_solana_rpc"
        },
        createdAt: now
      })
      .onConflictDoNothing({
        target: [
          workspaceLedgerEntries.workspaceId,
          workspaceLedgerEntries.idempotencyKey
        ]
      })
      .returning({ id: workspaceLedgerEntries.id });
    let status: "recorded" | "duplicate";
    if (entries[0]) {
      status = "recorded";
    } else {
      const priorRows = await tx.select({
        status: workspaceLedgerEntries.status,
        amountBaseUnits: workspaceLedgerEntries.amountBaseUnits,
        referenceType: workspaceLedgerEntries.referenceType,
        referenceId: workspaceLedgerEntries.referenceId,
        transactionSignature: workspaceLedgerEntries.transactionSignature,
        metadata: workspaceLedgerEntries.metadata
      }).from(workspaceLedgerEntries).where(and(
        eq(workspaceLedgerEntries.workspaceId, input.workspaceId),
        eq(workspaceLedgerEntries.idempotencyKey, "gas-tank-funding:" + input.signature)
      )).for("update").limit(1);
      const prior = priorRows[0];
      const priorMetadata = prior?.metadata !== null &&
        typeof prior?.metadata === "object" && !Array.isArray(prior.metadata)
        ? prior.metadata as Record<string, unknown> : null;
      const sameEvidence = prior?.status === "finalized" &&
        prior.amountBaseUnits === input.amountLamports &&
        prior.referenceType === "gas_tank" &&
        prior.referenceId === input.workspaceId &&
        prior.transactionSignature === input.signature &&
        priorMetadata?.asset === "SOL" &&
        priorMetadata?.source === input.source &&
        priorMetadata?.destination === input.destination &&
        priorMetadata?.amountLamports === input.amountLamports &&
        priorMetadata?.valueTransferred === true &&
        priorMetadata?.sourceOfTruth === "finalized_solana_rpc";
      if (!sameEvidence) return { status: "conflict" as const };
      status = "duplicate";
    }

    await tx
      .update(workspaceGasTanks)
      .set({
        balanceLamports: input.confirmedBalanceLamports,
        lastActivityAt: now,
        updatedAt: now
      })
      .where(and(
        eq(workspaceGasTanks.workspaceId, input.workspaceId),
        eq(workspaceGasTanks.address, input.destination)
      ));

    const members = await tx
      .select({ userId: workspaceMemberships.userId })
      .from(workspaceMemberships)
      .where(and(
        eq(workspaceMemberships.workspaceId, input.workspaceId),
        or(
          eq(workspaceMemberships.role, "organization_admin"),
          eq(workspaceMemberships.role, "finance_auditor")
        )
      ));
    await tx
      .insert(workspaceNotifications)
      .values(members.map((member) => ({
        workspaceId: input.workspaceId,
        recipientKey: member.userId,
        eventKey: "gas-tank-funding:" + input.signature,
        category: "Gas Tank & Network Operations",
        title: "Gas Tank funded",
        body: "A finalized manual SOL transfer was reconciled to this workspace Gas Tank.",
        destination: "/workspace/" + input.workspaceId + "/gas-tank",
        createdAt: now
      })))
      .onConflictDoNothing({
        target: [
          workspaceNotifications.workspaceId,
          workspaceNotifications.eventKey,
          workspaceNotifications.recipientKey
        ]
      });
    return { status };
  });
}


export async function getWorkspaceGasTankOperation(
  db: Database,
  workspaceId: string,
  operationId: string
) {
  const rows = await db.select().from(gasTankOperations).where(and(
    eq(gasTankOperations.workspaceId, workspaceId),
    eq(gasTankOperations.id, operationId)
  )).limit(1);
  return rows[0] ?? null;
}

export async function getWorkspaceGasTankOperationByIdempotencyKey(
  db: Database,
  workspaceId: string,
  idempotencyKey: string
) {
  const rows = await db.select().from(gasTankOperations).where(and(
    eq(gasTankOperations.workspaceId, workspaceId),
    eq(gasTankOperations.idempotencyKey, idempotencyKey)
  )).limit(1);
  return rows[0] ?? null;
}

export async function listWorkspaceGasTankOperations(
  db: Database,
  workspaceId: string,
  requestedLimit = 20
) {
  const limit = Number.isSafeInteger(requestedLimit)
    ? Math.min(Math.max(requestedLimit, 1), 50)
    : 20;
  return db
    .select({
      id: gasTankOperations.id,
      operationType: gasTankOperations.operationType,
      status: gasTankOperations.status,
      transactionSignature: gasTankOperations.transactionSignature,
      feeLamports: gasTankOperations.feeLamports,
      failureCode: gasTankOperations.failureCode,
      createdAt: gasTankOperations.createdAt,
      updatedAt: gasTankOperations.updatedAt
    })
    .from(gasTankOperations)
    .where(eq(gasTankOperations.workspaceId, workspaceId))
    .orderBy(desc(gasTankOperations.createdAt))
    .limit(limit);
}

/** Finds only prepared confidential-account sponsorships owned by this contributor. */
export async function listPreparedGasTankConfidentialSetupOperations(
  db: Database,
  workspaceId: string,
  ownerAddress: string
) {
  return db
    .select({
      id: gasTankOperations.id,
      transactionSignature: gasTankOperations.transactionSignature,
      feeLamports: gasTankOperations.feeLamports,
      operationData: gasTankOperations.operationData,
      updatedAt: gasTankOperations.updatedAt
    })
    .from(gasTankOperations)
    .where(and(
      eq(gasTankOperations.workspaceId, workspaceId),
      eq(gasTankOperations.operationType, "confidential_account_setup"),
      eq(gasTankOperations.status, "prepared"),
      isNotNull(gasTankOperations.transactionSignature),
      sql`${gasTankOperations.operationData}->>'ownerAddress' = ${ownerAddress}`
    ))
    .orderBy(asc(gasTankOperations.createdAt))
    .limit(101);
}

/** Reconciles a sponsored setup only when finalized owner, mint, ATA, and transaction identity agree. */
export async function finalizeGasTankConfidentialAccountSetupForVerifiedAccount(
  db: Database,
  input: {
    workspaceId: string;
    transactionSignature: string;
    ownerAddress: string;
    mintAddress: string;
    tokenAccountAddress: string;
  }
): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .select()
      .from(gasTankOperations)
      .where(and(
        eq(gasTankOperations.workspaceId, input.workspaceId),
        eq(gasTankOperations.operationType, "confidential_account_setup"),
        eq(gasTankOperations.transactionSignature, input.transactionSignature)
      ))
      .for("update")
      .limit(1);
    const operation = rows[0];
    if (!operation) return false;

    const data = operation.operationData !== null &&
      typeof operation.operationData === "object" &&
      !Array.isArray(operation.operationData)
      ? operation.operationData as Record<string, unknown>
      : {};
    if (
      data.ownerAddress !== input.ownerAddress ||
      data.mintAddress !== input.mintAddress ||
      data.tokenAccountAddress !== input.tokenAccountAddress
    ) {
      return false;
    }
    if (operation.status === "finalized") return true;
    if (operation.status !== "prepared") return false;

    const now = new Date();
    const updated = await tx
      .update(gasTankOperations)
      .set({ status: "finalized", updatedAt: now })
      .where(and(
        eq(gasTankOperations.id, operation.id),
        eq(gasTankOperations.workspaceId, input.workspaceId),
        eq(gasTankOperations.transactionSignature, input.transactionSignature),
        eq(gasTankOperations.status, "prepared")
      ))
      .returning({ id: gasTankOperations.id });
    if (!updated[0]) return false;

    await tx.update(workspaceGasTanks)
      .set({ lastActivityAt: now, updatedAt: now })
      .where(eq(workspaceGasTanks.workspaceId, input.workspaceId));
    return true;
  });
}



/** Serializes one Reserve confidential funding operation per workspace and keys it to the verified wrap signature. */
export async function beginWorkspaceReserveFundingOperation(
  db: Database,
  input: {
    workspaceId: string;
    idempotencyKey: string;
    requestDigest: string;
    wrapSignature: string;
    operationData: Record<string, unknown>;
  }
) {
  if (
    input.idempotencyKey.length < 24 || input.idempotencyKey.length > 160 ||
    !/^[0-9a-f]{64}$/.test(input.requestDigest) ||
    !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(input.wrapSignature)
  ) {
    return { status: "invalid" as const, operation: null };
  }
  return db.transaction(async (tx) => {
    const reserveRows = await tx.select({ workspaceId: workspaceReserves.workspaceId })
      .from(workspaceReserves)
      .where(eq(workspaceReserves.workspaceId, input.workspaceId))
      .for("update")
      .limit(1);
    if (!reserveRows[0]) return { status: "reserve_not_found" as const, operation: null };

    const existingRows = await tx.select().from(gasTankOperations).where(and(
      eq(gasTankOperations.workspaceId, input.workspaceId),
      eq(gasTankOperations.idempotencyKey, input.idempotencyKey)
    )).for("update").limit(1);
    const existing = existingRows[0];
    if (existing) {
      if (
        existing.operationType !== RESERVE_FUNDING_OPERATION_TYPE ||
        existing.requestDigest !== input.requestDigest ||
        existing.transactionSignature !== input.wrapSignature
      ) {
        return { status: "conflict" as const, operation: existing };
      }
      return {
        status: existing.status === "finalized" ? "finalized" as const : "existing" as const,
        operation: existing
      };
    }

    const activeRows = await tx.select().from(gasTankOperations).where(and(
      eq(gasTankOperations.workspaceId, input.workspaceId),
      eq(gasTankOperations.operationType, RESERVE_FUNDING_OPERATION_TYPE),
      inArray(gasTankOperations.status, ["preparing", "prepared"])
    )).for("update").limit(1);
    if (activeRows[0]) return { status: "in_progress" as const, operation: activeRows[0] };

    const now = new Date();
    const inserted = await tx.insert(gasTankOperations).values({
      workspaceId: input.workspaceId,
      idempotencyKey: input.idempotencyKey,
      operationType: RESERVE_FUNDING_OPERATION_TYPE,
      requestDigest: input.requestDigest,
      status: "preparing",
      transactionSignature: input.wrapSignature,
      feeLamports: "0",
      operationData: { ...input.operationData, stage: "wrap_verified" },
      createdAt: now,
      updatedAt: now
    }).onConflictDoNothing({
      target: [gasTankOperations.workspaceId, gasTankOperations.idempotencyKey]
    }).returning();
    if (inserted[0]) return { status: "created" as const, operation: inserted[0] };

    const raced = await tx.select().from(gasTankOperations).where(and(
      eq(gasTankOperations.workspaceId, input.workspaceId),
      eq(gasTankOperations.idempotencyKey, input.idempotencyKey)
    )).for("update").limit(1);
    return raced[0] && raced[0].requestDigest === input.requestDigest
      ? { status: "existing" as const, operation: raced[0] }
      : { status: "conflict" as const, operation: raced[0] ?? null };
  });
}

/** A row lock and legal stage transition prevent two retries from submitting the same Reserve action. */
export async function advanceWorkspaceReserveFundingOperation(
  db: Database,
  input: {
    workspaceId: string;
    operationId: string;
    expectedStage: ReserveFundingOperationStage;
    nextStage: ReserveFundingOperationStage;
    operationData?: Record<string, unknown>;
    feeLamportsAdded?: string;
  }
): Promise<"updated" | "duplicate" | "conflict" | "not_found"> {
  if (
    !canAdvanceReserveFundingStage(input.expectedStage, input.nextStage) ||
    (input.feeLamportsAdded !== undefined &&
      !/^(0|[1-9][0-9]*)$/.test(input.feeLamportsAdded))
  ) return "conflict";

  return db.transaction(async (tx) => {
    const rows = await tx.select().from(gasTankOperations).where(and(
      eq(gasTankOperations.workspaceId, input.workspaceId),
      eq(gasTankOperations.id, input.operationId),
      eq(gasTankOperations.operationType, RESERVE_FUNDING_OPERATION_TYPE)
    )).for("update").limit(1);
    const operation = rows[0];
    if (!operation) return "not_found";
    const current = operation.operationData !== null &&
      typeof operation.operationData === "object" &&
      !Array.isArray(operation.operationData)
      ? operation.operationData as Record<string, unknown>
      : {};
    if (current.stage === input.nextStage) {
      const patchMatches = Object.entries(input.operationData ?? {}).every(([key, value]) =>
        JSON.stringify(current[key]) === JSON.stringify(value)
      );
      return patchMatches ? "duplicate" : "conflict";
    }
    if (
      operation.status !== "preparing" ||
      current.stage !== input.expectedStage ||
      !canAdvanceReserveFundingStage(String(current.stage ?? ""), input.nextStage)
    ) return "conflict";

    const currentFee = operation.feeLamports !== null &&
      /^(0|[1-9][0-9]*)$/.test(operation.feeLamports)
      ? BigInt(operation.feeLamports)
      : null;
    if (currentFee === null) return "conflict";
    const nextFee = currentFee + BigInt(input.feeLamportsAdded ?? "0");
    if (nextFee >= (1n << 64n)) return "conflict";
    const updated = await tx.update(gasTankOperations).set({
      status: input.nextStage === "finalized" ? "finalized" : "preparing",
      feeLamports: nextFee.toString(),
      operationData: {
        ...current,
        ...(input.operationData ?? {}),
        stage: input.nextStage
      },
      updatedAt: new Date()
    }).where(and(
      eq(gasTankOperations.workspaceId, input.workspaceId),
      eq(gasTankOperations.id, input.operationId),
      eq(gasTankOperations.operationType, RESERVE_FUNDING_OPERATION_TYPE),
      eq(gasTankOperations.status, "preparing")
    )).returning({ id: gasTankOperations.id });
    return updated[0] ? "updated" : "conflict";
  });
}


export async function getActiveWorkspaceReserveFundingOperation(
  db: Database,
  workspaceId: string
) {
  const rows = await db.select().from(gasTankOperations).where(and(
    eq(gasTankOperations.workspaceId, workspaceId),
    eq(gasTankOperations.operationType, RESERVE_FUNDING_OPERATION_TYPE),
    inArray(gasTankOperations.status, ["preparing", "prepared"])
  )).orderBy(desc(gasTankOperations.createdAt)).limit(1);
  return rows[0] ?? null;
}

export async function beginGasTankOperationAttempt(
  db: Database,
  input: {
    workspaceId: string;
    idempotencyKey: string;
    operationType: string;
    requestDigest: string;
    reservedFeeLamports: string;
    availableBalanceLamports: string;
    maxDailyFeeLamports: string;
    maxDailyOperations: number;
    since: Date;
    operationData?: Record<string, unknown>;
  }
) {
  const positiveInteger = (value: string) =>
    /^(0|[1-9][0-9]*)$/.test(value) && BigInt(value) < (1n << 64n);
  if (
    !positiveInteger(input.reservedFeeLamports) ||
    !positiveInteger(input.availableBalanceLamports) ||
    !positiveInteger(input.maxDailyFeeLamports) ||
    !Number.isSafeInteger(input.maxDailyOperations) ||
    input.maxDailyOperations < 1
  ) {
    throw new Error("Invalid Gas Tank sponsorship budget input.");
  }
  const now = new Date();
  return db.transaction(async (tx) => {
    // The workspace Gas Tank row serializes budget reservations for this workspace.
    const tanks = await tx
      .select({ workspaceId: workspaceGasTanks.workspaceId })
      .from(workspaceGasTanks)
      .where(eq(workspaceGasTanks.workspaceId, input.workspaceId))
      .for("update")
      .limit(1);
    if (!tanks[0]) {
      return { status: "gas_tank_not_initialized" as const, operation: null };
    }

    const existingRows = await tx
      .select()
      .from(gasTankOperations)
      .where(and(
        eq(gasTankOperations.workspaceId, input.workspaceId),
        eq(gasTankOperations.idempotencyKey, input.idempotencyKey)
      ))
      .limit(1);
    const existing = existingRows[0];
    if (existing && existing.requestDigest !== input.requestDigest) {
      return { status: "conflict" as const, operation: existing };
    }
    if (existing && existing.status !== "cancelled" && existing.status !== "failed") {
      return { status: existing.status as string, operation: existing };
    }

    const recent = await tx
      .select({
        status: gasTankOperations.status,
        feeLamports: gasTankOperations.feeLamports,
        failureCode: gasTankOperations.failureCode,
        operationData: gasTankOperations.operationData
      })
      .from(gasTankOperations)
      .where(and(
        eq(gasTankOperations.workspaceId, input.workspaceId),
        or(
          gte(gasTankOperations.createdAt, input.since),
          gte(gasTankOperations.updatedAt, input.since)
        )
      ))
      .limit(1001);
    if (recent.length > 1000) {
      return { status: "gas_tank_daily_sponsorship_limit" as const, operation: existing ?? null };
    }
    const usage = summarizeGasTankSponsorshipBudget({
      rows: recent,
      reservedFeeLamports: input.reservedFeeLamports,
      since: input.since
    });
    const dailyFees = usage.feeLamports;
    const dailyOperations = usage.operationCount;
    const reservedFees = usage.reservedFeesLamports;
    const reservedRent = sumPreparedSponsoredRentReservations(recent);
    const requestedRentValue = input.operationData?.reservedRentLamports ?? "0";
    if (typeof requestedRentValue !== "string" || !/^(0|[1-9][0-9]*)$/.test(requestedRentValue)) {
      throw new Error("Invalid Gas Tank sponsored rent reservation.");
    }
    const requestedRent = BigInt(requestedRentValue);

    const available = BigInt(input.availableBalanceLamports);
    const requestedReservation = BigInt(input.reservedFeeLamports);
    if (available < reservedFees + requestedReservation + reservedRent + requestedRent) {
      return { status: "gas_tank_insufficient_balance" as const, operation: existing ?? null };
    }
    if (
      dailyOperations >= input.maxDailyOperations ||
      dailyFees + requestedReservation > BigInt(input.maxDailyFeeLamports)
    ) {
      return { status: "gas_tank_daily_sponsorship_limit" as const, operation: existing ?? null };
    }

    if (existing) {
      const restarted = await tx
        .update(gasTankOperations)
        .set({
          status: "preparing",
          transactionSignature: null,
          feeLamports: input.reservedFeeLamports,
          failureCode: null,
          lastValidBlockHeight: null,
          operationData: operationDataForGasTankRetry({
            nextOperationData: input.operationData,
            previousOperation: existing,
            since: input.since
          }),
          createdAt: now,
          updatedAt: now
        })
        .where(and(
          eq(gasTankOperations.id, existing.id),
          eq(gasTankOperations.workspaceId, input.workspaceId),
          inArray(gasTankOperations.status, ["cancelled", "failed"])
        ))
        .returning();
      return restarted[0]
        ? { status: "started" as const, operation: restarted[0] }
        : { status: "conflict" as const, operation: existing };
    }

    const inserted = await tx
      .insert(gasTankOperations)
      .values({
        workspaceId: input.workspaceId,
        idempotencyKey: input.idempotencyKey,
        operationType: input.operationType,
        requestDigest: input.requestDigest,
        status: "preparing",
        feeLamports: input.reservedFeeLamports,
        operationData: input.operationData ?? null,
        createdAt: now,
        updatedAt: now
      })
      .onConflictDoNothing({
        target: [gasTankOperations.workspaceId, gasTankOperations.idempotencyKey]
      })
      .returning();
    return inserted[0]
      ? { status: "started" as const, operation: inserted[0] }
      : { status: "conflict" as const, operation: null };
  });
}
export async function updateGasTankOperationAttempt(
  db: Database,
  input: {
    workspaceId: string;
    operationId: string;
    status: "prepared" | "finalized" | "failed" | "cancelled";
    expectedUpdatedAt?: Date;
    transactionSignature?: string | null;
    feeLamports?: string | null;
    failureCode?: string | null;
    lastValidBlockHeight?: string | null;
    operationData?: Record<string, unknown> | null;
  }
): Promise<boolean> {
  const previousStatuses =
    input.status === "finalized"
      ? ["prepared"]
      : input.status === "failed" && input.failureCode === "finalized_chain_failure"
        ? ["prepared"]
        : input.status === "cancelled" && input.failureCode === "recent_blockhash_expired"
          ? ["prepared"]
          : input.status === "prepared" || input.status === "failed" || input.status === "cancelled"
            ? ["preparing"]
            : ["prepared"];
  const update = await db
    .update(gasTankOperations)
    .set({
      status: input.status,
      ...(input.transactionSignature !== undefined
        ? { transactionSignature: input.transactionSignature }
        : {}),
      ...(input.feeLamports !== undefined
        ? { feeLamports: input.feeLamports }
        : {}),
      ...(input.failureCode !== undefined
        ? { failureCode: input.failureCode }
        : {}),
      ...(input.lastValidBlockHeight !== undefined
        ? { lastValidBlockHeight: input.lastValidBlockHeight }
        : {}),
      ...(input.operationData !== undefined
        ? { operationData: input.operationData }
        : {}),
      updatedAt: new Date()
    })
    .where(and(
      eq(gasTankOperations.id, input.operationId),
      eq(gasTankOperations.workspaceId, input.workspaceId),
      inArray(gasTankOperations.status, previousStatuses),
      ...(input.expectedUpdatedAt ? [eq(gasTankOperations.updatedAt, input.expectedUpdatedAt)] : []),
      ...((input.status === "finalized" ||
          (input.status === "failed" && input.failureCode === "finalized_chain_failure") ||
          (input.status === "cancelled" && input.failureCode === "recent_blockhash_expired")) &&
          input.transactionSignature !== undefined
        ? [eq(gasTankOperations.transactionSignature, input.transactionSignature!)]
        : [])
    ))
    .returning({ id: gasTankOperations.id });
  if (update[0]) {
    if (
      input.status === "finalized" ||
      input.failureCode === "finalized_chain_failure" ||
      input.failureCode === "recent_blockhash_expired"
    ) {
      try {
        await db.update(workspaceGasTanks)
          .set({ lastActivityAt: new Date(), updatedAt: new Date() })
          .where(eq(workspaceGasTanks.workspaceId, input.workspaceId));
      } catch {
        // The operation state remains authoritative if the activity timestamp cannot be refreshed.
      }
    }
    return true;
  }

  const rows = await db
    .select({
      status: gasTankOperations.status,
      transactionSignature: gasTankOperations.transactionSignature,
      updatedAt: gasTankOperations.updatedAt
    })
    .from(gasTankOperations)
    .where(and(
      eq(gasTankOperations.id, input.operationId),
      eq(gasTankOperations.workspaceId, input.workspaceId)
    ))
    .limit(1);
  return Boolean(
    rows[0] &&
    rows[0].status === input.status &&
    (input.transactionSignature === undefined ||
      rows[0].transactionSignature === input.transactionSignature) &&
    (!input.expectedUpdatedAt ||
      rows[0].updatedAt.getTime() === input.expectedUpdatedAt.getTime())
  );
}

export async function getWorkspaceGasTankSponsorshipUsage(
  db: Database,
  workspaceId: string,
  since: Date
) {
  const rows = await db
    .select({
      status: gasTankOperations.status,
      feeLamports: gasTankOperations.feeLamports,
      failureCode: gasTankOperations.failureCode,
      operationData: gasTankOperations.operationData
    })
    .from(gasTankOperations)
    .where(and(
      eq(gasTankOperations.workspaceId, workspaceId),
      or(
        gte(gasTankOperations.createdAt, since),
        gte(gasTankOperations.updatedAt, since)
      )
    ))
    .limit(1001);
  return summarizeGasTankSponsorshipBudget({
    rows,
    reservedFeeLamports: "100000",
    since
  });
}


export async function attachPayrollClaimEscrowAccountSetupSignature(
  db: Database,
  input: { workspaceId: string; allocationId: string; signature: string }
) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(input.signature)) return false;
  const updated = await db.update(payrollClaimEscrows).set({
    accountSetupSignature: input.signature,
    updatedAt: new Date()
  }).where(and(
    eq(payrollClaimEscrows.workspaceId, input.workspaceId),
    eq(payrollClaimEscrows.allocationId, input.allocationId),
    eq(payrollClaimEscrows.status, "preparing"),
    or(
      isNull(payrollClaimEscrows.accountSetupSignature),
      eq(payrollClaimEscrows.accountSetupSignature, input.signature)
    )
  )).returning({ allocationId: payrollClaimEscrows.allocationId });
  if (updated[0]) return true;
  const current = await getPayrollClaimEscrow(db, input.workspaceId, input.allocationId);
  return Boolean(current && current.accountSetupSignature === input.signature);
}

export async function resetFailedPayrollClaimEscrowAccountSetup(
  db: Database,
  input: { workspaceId: string; allocationId: string; signature: string }
) {
  const updated = await db.update(payrollClaimEscrows).set({
    accountSetupSignature: null,
    updatedAt: new Date()
  }).where(and(
    eq(payrollClaimEscrows.workspaceId, input.workspaceId),
    eq(payrollClaimEscrows.allocationId, input.allocationId),
    eq(payrollClaimEscrows.status, "preparing"),
    eq(payrollClaimEscrows.accountSetupSignature, input.signature)
  )).returning({ allocationId: payrollClaimEscrows.allocationId });
  return Boolean(updated[0]);
}

export async function appendPayrollClaimEscrowConfidentialSetupSignature(
  db: Database,
  input: { workspaceId: string; allocationId: string; signature: string }
) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(input.signature)) return false;
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(payrollClaimEscrows).where(and(
      eq(payrollClaimEscrows.workspaceId, input.workspaceId),
      eq(payrollClaimEscrows.allocationId, input.allocationId)
    )).for("update").limit(1);
    const escrow = rows[0];
    if (!escrow || !["preparing", "ready"].includes(escrow.status)) return false;
    if (escrow.confidentialSetupSignatures.includes(input.signature)) return true;
    const updated = await tx.update(payrollClaimEscrows).set({
      confidentialSetupSignatures: [...escrow.confidentialSetupSignatures, input.signature],
      updatedAt: new Date()
    }).where(and(
      eq(payrollClaimEscrows.workspaceId, input.workspaceId),
      eq(payrollClaimEscrows.allocationId, input.allocationId),
      eq(payrollClaimEscrows.status, escrow.status)
    )).returning({ allocationId: payrollClaimEscrows.allocationId });
    return Boolean(updated[0]);
  });
}

export async function getPayrollClaimEscrow(
  db: Database,
  workspaceId: string,
  allocationId: string
) {
  const rows = await db.select().from(payrollClaimEscrows).where(and(
    eq(payrollClaimEscrows.workspaceId, workspaceId),
    eq(payrollClaimEscrows.allocationId, allocationId)
  )).limit(1);
  return rows[0] ?? null;
}

export async function createPayrollClaimEscrow(
  db: Database,
  input: {
    workspaceId: string;
    payrollRunId: string;
    allocationId: string;
    claimId: string;
    tokenAccountAddress: string;
    encryptedPrivateKey: string;
    privateKeyNonce: string;
    privateKeyAuthTag: string;
    encryptedDataKey: string;
    dataKeyNonce: string;
    dataKeyAuthTag: string;
    encryptedBackup: string;
    backupNonce: string;
    backupAuthTag: string;
  }
) {
  const allocationRows = await db.select({
    id: payrollAllocations.id,
    claimId: payrollAllocations.claimId
  }).from(payrollAllocations).where(and(
    eq(payrollAllocations.id, input.allocationId),
    eq(payrollAllocations.workspaceId, input.workspaceId),
    eq(payrollAllocations.payrollRunId, input.payrollRunId),
    eq(payrollAllocations.claimId, input.claimId),
    eq(payrollAllocations.status, "unclaimed")
  )).limit(1);
  if (!allocationRows[0]) return { status: "allocation_ineligible" as const };

  const created = await db.insert(payrollClaimEscrows).values({
    ...input,
    status: "preparing"
  }).onConflictDoNothing({
    target: payrollClaimEscrows.allocationId
  }).returning();
  if (created[0]) return { status: "created" as const, escrow: created[0] };

  const existing = await getPayrollClaimEscrow(db, input.workspaceId, input.allocationId);
  if (!existing || existing.payrollRunId !== input.payrollRunId || existing.claimId !== input.claimId) {
    return { status: "conflict" as const };
  }
  return { status: "existing" as const, escrow: existing };
}

export async function markPayrollClaimEscrowReady(
  db: Database,
  input: { workspaceId: string; allocationId: string; tokenAccountAddress: string }
) {
  const updated = await db.update(payrollClaimEscrows).set({
    status: "ready",
    encryptedPrivateKey: null,
    privateKeyNonce: null,
    privateKeyAuthTag: null,
    encryptedDataKey: null,
    dataKeyNonce: null,
    dataKeyAuthTag: null,
    encryptedBackup: null,
    backupNonce: null,
    backupAuthTag: null,
    updatedAt: new Date()
  }).where(and(
    eq(payrollClaimEscrows.workspaceId, input.workspaceId),
    eq(payrollClaimEscrows.allocationId, input.allocationId),
    eq(payrollClaimEscrows.tokenAccountAddress, input.tokenAccountAddress),
    inArray(payrollClaimEscrows.status, ["preparing", "failed"])
  )).returning({ tokenAccountAddress: payrollClaimEscrows.tokenAccountAddress });
  if (updated[0]) return { status: "ready" as const };
  const existing = await getPayrollClaimEscrow(db, input.workspaceId, input.allocationId);
  return existing && existing.tokenAccountAddress === input.tokenAccountAddress &&
    ["ready", "funding", "funded", "settlement_pending", "recovery_pending", "claimed", "recovered"].includes(existing.status)
    ? { status: existing.status as "ready" | "funding" | "funded" | "settlement_pending" | "recovery_pending" | "claimed" | "recovered" }
    : { status: "conflict" as const };
}

export async function beginPayrollClaimEscrowFunding(
  db: Database,
  input: { workspaceId: string; allocationId: string }
) {
  return db.transaction(async (tx) => {
    const reserveRows = await tx.select({ workspaceId: workspaceReserves.workspaceId })
      .from(workspaceReserves)
      .where(eq(workspaceReserves.workspaceId, input.workspaceId))
      .for("update")
      .limit(1);
    if (!reserveRows[0]) return { status: "reserve_not_found" as const };
    if (await hasActiveReserveConfidentialFunding(tx, input.workspaceId)) {
      return { status: "workspace_busy" as const };
    }
    const updated = await tx.update(payrollClaimEscrows).set({
      status: "funding",
      updatedAt: new Date()
    }).where(and(
      eq(payrollClaimEscrows.workspaceId, input.workspaceId),
      eq(payrollClaimEscrows.allocationId, input.allocationId),
      eq(payrollClaimEscrows.status, "ready")
    )).returning({ tokenAccountAddress: payrollClaimEscrows.tokenAccountAddress });
    if (updated[0]) return { status: "started" as const, tokenAccountAddress: updated[0].tokenAccountAddress };
    const existing = await tx.select().from(payrollClaimEscrows).where(and(
      eq(payrollClaimEscrows.workspaceId, input.workspaceId),
      eq(payrollClaimEscrows.allocationId, input.allocationId)
    )).limit(1);
    if (!existing[0]) return { status: "not_found" as const };
    if (existing[0].status === "funded") {
      return { status: "funded" as const, tokenAccountAddress: existing[0].tokenAccountAddress };
    }
    if (existing[0].status === "funding") {
      return {
        status: "pending" as const,
        tokenAccountAddress: existing[0].tokenAccountAddress,
        signature: existing[0].fundingSignature ?? undefined
      };
    }
    return { status: "conflict" as const, tokenAccountAddress: existing[0].tokenAccountAddress };
  });
}

export async function preparePayrollClaimEscrowFundingAttempt(
  db: Database,
  input: {
    workspaceId: string;
    allocationId: string;
    sourceAvailableBefore: string;
    destinationAvailableBefore: string;
    now?: Date;
  }
) {
  if (!/^(0|[1-9][0-9]*)$/.test(input.sourceAvailableBefore) ||
      !/^(0|[1-9][0-9]*)$/.test(input.destinationAvailableBefore)) {
    return { status: "invalid_balance" as const };
  }
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(payrollClaimEscrows).where(and(
      eq(payrollClaimEscrows.workspaceId, input.workspaceId),
      eq(payrollClaimEscrows.allocationId, input.allocationId)
    )).for("update").limit(1);
    const escrow = rows[0];
    if (!escrow) return { status: "not_found" as const };
    if (escrow.status !== "funding" || escrow.fundingSignature !== null) {
      return { status: "conflict" as const };
    }
    if (escrow.fundingSourceAvailableBefore !== null || escrow.fundingDestinationAvailableBefore !== null) {
      return escrow.fundingSourceAvailableBefore === input.sourceAvailableBefore &&
        escrow.fundingDestinationAvailableBefore === input.destinationAvailableBefore
        ? { status: "duplicate" as const }
        : { status: "conflict" as const };
    }
    const updated = await tx.update(payrollClaimEscrows).set({
      fundingSourceAvailableBefore: input.sourceAvailableBefore,
      fundingDestinationAvailableBefore: input.destinationAvailableBefore,
      updatedAt: input.now ?? new Date()
    }).where(and(
      eq(payrollClaimEscrows.workspaceId, input.workspaceId),
      eq(payrollClaimEscrows.allocationId, input.allocationId),
      eq(payrollClaimEscrows.status, "funding"),
      isNull(payrollClaimEscrows.fundingSignature),
      isNull(payrollClaimEscrows.fundingSourceAvailableBefore),
      isNull(payrollClaimEscrows.fundingDestinationAvailableBefore)
    )).returning({ allocationId: payrollClaimEscrows.allocationId });
    return updated[0] ? { status: "prepared" as const } : { status: "conflict" as const };
  });
}

export async function attachPayrollClaimEscrowFundingSignature(
  db: Database,
  input: {
    workspaceId: string;
    allocationId: string;
    signature: string;
    sourceAvailableBefore: string;
    destinationAvailableBefore: string;
  }
) {
  if (!/^(0|[1-9][0-9]*)$/.test(input.sourceAvailableBefore) ||
      !/^(0|[1-9][0-9]*)$/.test(input.destinationAvailableBefore)) return false;
  const updated = await db.update(payrollClaimEscrows).set({
    fundingSignature: input.signature,
    fundingSourceAvailableBefore: input.sourceAvailableBefore,
    fundingDestinationAvailableBefore: input.destinationAvailableBefore,
    updatedAt: new Date()
  }).where(and(
    eq(payrollClaimEscrows.workspaceId, input.workspaceId),
    eq(payrollClaimEscrows.allocationId, input.allocationId),
    eq(payrollClaimEscrows.status, "funding"),
    or(
      isNull(payrollClaimEscrows.fundingSignature),
      eq(payrollClaimEscrows.fundingSignature, input.signature)
    ),
    or(
      isNull(payrollClaimEscrows.fundingSourceAvailableBefore),
      eq(payrollClaimEscrows.fundingSourceAvailableBefore, input.sourceAvailableBefore)
    ),
    or(
      isNull(payrollClaimEscrows.fundingDestinationAvailableBefore),
      eq(payrollClaimEscrows.fundingDestinationAvailableBefore, input.destinationAvailableBefore)
    )
  )).returning({ allocationId: payrollClaimEscrows.allocationId });
  if (updated[0]) return true;
  const existing = await getPayrollClaimEscrow(db, input.workspaceId, input.allocationId);
  return Boolean(existing && existing.status === "funded" && existing.fundingSignature === input.signature);
}

export async function recordVerifiedPayrollClaimEscrowFunding(
  db: Database,
  input: {
    workspaceId: string;
    allocationId: string;
    signature: string;
    amountBaseUnits: string;
    sourceAvailableBefore: string;
    sourceAvailableAfter: string;
    destinationAvailableBefore: string;
    destinationAvailableAfter: string;
    now?: Date;
  }
) {
  const values = [
    input.amountBaseUnits,
    input.sourceAvailableBefore,
    input.sourceAvailableAfter,
    input.destinationAvailableBefore,
    input.destinationAvailableAfter
  ];
  if (!values.every((value) => /^(0|[1-9][0-9]*)$/.test(value)) || BigInt(input.amountBaseUnits) <= 0n) {
    return { status: "balance_mismatch" as const };
  }
  const amount = BigInt(input.amountBaseUnits);
  const sourceBefore = BigInt(input.sourceAvailableBefore);
  const sourceAfter = BigInt(input.sourceAvailableAfter);
  const destinationBefore = BigInt(input.destinationAvailableBefore);
  const destinationAfter = BigInt(input.destinationAvailableAfter);
  if (
    sourceBefore < sourceAfter || sourceBefore - sourceAfter !== amount ||
    destinationAfter < destinationBefore || destinationAfter - destinationBefore !== amount
  ) return { status: "balance_mismatch" as const };

  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(payrollClaimEscrows).where(and(
      eq(payrollClaimEscrows.workspaceId, input.workspaceId),
      eq(payrollClaimEscrows.allocationId, input.allocationId)
    )).for("update").limit(1);
    const escrow = rows[0];
    if (!escrow) return { status: "not_found" as const };
    if (escrow.status === "funded" && escrow.fundingSignature === input.signature &&
        escrow.fundingSourceAvailableBefore === input.sourceAvailableBefore &&
        escrow.fundingSourceAvailableAfter === input.sourceAvailableAfter &&
        escrow.fundingDestinationAvailableBefore === input.destinationAvailableBefore &&
        escrow.fundingDestinationAvailableAfter === input.destinationAvailableAfter) {
      return { status: "duplicate" as const };
    }
    if (escrow.status !== "funding" || escrow.fundingSignature !== input.signature ||
        escrow.fundingSourceAvailableBefore !== input.sourceAvailableBefore ||
        escrow.fundingDestinationAvailableBefore !== input.destinationAvailableBefore) {
      return { status: "conflict" as const };
    }
    const updated = await tx.update(payrollClaimEscrows).set({
      status: "funded",
      fundingSourceAvailableAfter: input.sourceAvailableAfter,
      fundingDestinationAvailableAfter: input.destinationAvailableAfter,
      fundedAt: now,
      updatedAt: now
    }).where(and(
      eq(payrollClaimEscrows.workspaceId, input.workspaceId),
      eq(payrollClaimEscrows.allocationId, input.allocationId),
      eq(payrollClaimEscrows.status, "funding"),
      eq(payrollClaimEscrows.fundingSignature, input.signature)
    )).returning({ allocationId: payrollClaimEscrows.allocationId });
    return updated[0] ? { status: "funded" as const } : { status: "conflict" as const };
  });
}

export async function resetFailedPayrollClaimEscrowFunding(
  db: Database,
  input: { workspaceId: string; allocationId: string; signature: string | null; now?: Date }
) {
  const signatureCondition = input.signature === null
    ? isNull(payrollClaimEscrows.fundingSignature)
    : eq(payrollClaimEscrows.fundingSignature, input.signature);
  const updated = await db.update(payrollClaimEscrows).set({
    status: "ready",
    fundingSignature: null,
    fundingSourceAvailableBefore: null,
    fundingSourceAvailableAfter: null,
    fundingDestinationAvailableBefore: null,
    fundingDestinationAvailableAfter: null,
    updatedAt: input.now ?? new Date()
  }).where(and(
    eq(payrollClaimEscrows.workspaceId, input.workspaceId),
    eq(payrollClaimEscrows.allocationId, input.allocationId),
    eq(payrollClaimEscrows.status, "funding"),
    signatureCondition
  )).returning({ allocationId: payrollClaimEscrows.allocationId });
  if (updated[0]) return true;
  const existing = await getPayrollClaimEscrow(db, input.workspaceId, input.allocationId);
  return Boolean(existing && existing.status === "ready" && existing.fundingSignature === null);
}

export async function beginPayrollRecoveryAttempt(
  db: Database,
  input: {
    workspaceId: string;
    runId: string;
    allocationId: string;
    reason: "incorrect_allocation" | "contributor_left_before_claim" | "payroll_correction" | "other";
    reasonNote: string | null;
  }
) {
  return db.transaction(async (tx) => {
    const reserveRows = await tx.select({ workspaceId: workspaceReserves.workspaceId })
      .from(workspaceReserves)
      .where(eq(workspaceReserves.workspaceId, input.workspaceId))
      .for("update")
      .limit(1);
    if (!reserveRows[0]) return { status: "reserve_not_found" as const };
    if (await hasActiveReserveConfidentialFunding(tx, input.workspaceId)) {
      return { status: "workspace_busy" as const };
    }
    const pendingRows = await tx.select({ id: payrollAllocations.id })
      .from(payrollAllocations)
      .where(and(
        eq(payrollAllocations.workspaceId, input.workspaceId),
        inArray(payrollAllocations.status, ["settlement_pending", "recovery_pending"])
      ))
      .for("update")
      .limit(1);
    if (pendingRows.length > 0) return { status: "workspace_busy" as const };

    const allocationRows = await tx.select({
      status: payrollAllocations.status
    }).from(payrollAllocations).where(and(
      eq(payrollAllocations.workspaceId, input.workspaceId),
      eq(payrollAllocations.payrollRunId, input.runId),
      eq(payrollAllocations.id, input.allocationId)
    )).for("update").limit(1);
    if (!allocationRows[0]) return { status: "not_found" as const };
    if (allocationRows[0].status !== "unclaimed") return { status: "state_conflict" as const };

    const escrowRows = await tx.select({
      status: payrollClaimEscrows.status,
      tokenAccountAddress: payrollClaimEscrows.tokenAccountAddress
    }).from(payrollClaimEscrows).where(and(
      eq(payrollClaimEscrows.workspaceId, input.workspaceId),
      eq(payrollClaimEscrows.payrollRunId, input.runId),
      eq(payrollClaimEscrows.allocationId, input.allocationId)
    )).for("update").limit(1);
    const escrow = escrowRows[0];
    if (!escrow) return { status: "escrow_not_found" as const };
    if (escrow.status !== "funded") return { status: "escrow_not_funded" as const };

    const updatedAllocation = await tx.update(payrollAllocations).set({
      status: "recovery_pending",
      updatedAt: new Date()
    }).where(and(
      eq(payrollAllocations.workspaceId, input.workspaceId),
      eq(payrollAllocations.payrollRunId, input.runId),
      eq(payrollAllocations.id, input.allocationId),
      eq(payrollAllocations.status, "unclaimed")
    )).returning({ id: payrollAllocations.id });
    if (!updatedAllocation[0]) return { status: "state_conflict" as const };

    const updatedEscrow = await tx.update(payrollClaimEscrows).set({
      status: "recovery_pending",
      recoverySignature: null,
      recoveryApplySignature: null,
      recoveryReason: input.reason,
      recoveryReasonNote: input.reasonNote,
      recoveryProofContextAddresses: [],
      recoveryContextSignatures: [],
      recoverySourceAvailableBefore: null,
      recoverySourceAvailableAfter: null,
      recoveryDestinationAvailableBefore: null,
      recoveryDestinationAvailableAfter: null,
      updatedAt: new Date()
    }).where(and(
      eq(payrollClaimEscrows.workspaceId, input.workspaceId),
      eq(payrollClaimEscrows.allocationId, input.allocationId),
      eq(payrollClaimEscrows.status, "funded")
    )).returning({ tokenAccountAddress: payrollClaimEscrows.tokenAccountAddress });
    if (!updatedEscrow[0]) throw new Error("The payroll claim escrow changed during recovery reservation.");
    return { status: "started" as const, tokenAccountAddress: updatedEscrow[0].tokenAccountAddress };
  });
}

export async function attachPayrollClaimEscrowRecoverySignature(
  db: Database,
  input: { workspaceId: string; allocationId: string; signature: string }
) {
  const updated = await db.update(payrollClaimEscrows).set({
    recoverySignature: input.signature,
    updatedAt: new Date()
  }).where(and(
    eq(payrollClaimEscrows.workspaceId, input.workspaceId),
    eq(payrollClaimEscrows.allocationId, input.allocationId),
    eq(payrollClaimEscrows.status, "recovery_pending"),
    or(
      isNull(payrollClaimEscrows.recoverySignature),
      eq(payrollClaimEscrows.recoverySignature, input.signature)
    )
  )).returning({ allocationId: payrollClaimEscrows.allocationId });
  if (updated[0]) return true;
  const existing = await getPayrollClaimEscrow(db, input.workspaceId, input.allocationId);
  return Boolean(existing && existing.status === "recovered" && existing.recoverySignature === input.signature);
}

export async function releasePayrollRecoveryAttempt(
  db: Database,
  input: { workspaceId: string; runId: string; allocationId: string }
) {
  return db.transaction(async (tx) => {
    const escrowRows = await tx.select().from(payrollClaimEscrows).where(and(
      eq(payrollClaimEscrows.workspaceId, input.workspaceId),
      eq(payrollClaimEscrows.payrollRunId, input.runId),
      eq(payrollClaimEscrows.allocationId, input.allocationId),
      eq(payrollClaimEscrows.status, "recovery_pending"),
      isNull(payrollClaimEscrows.recoverySignature)
    )).for("update").limit(1);
    if (!escrowRows[0]) return false;
    const allocation = await tx.update(payrollAllocations).set({
      status: "unclaimed",
      updatedAt: new Date()
    }).where(and(
      eq(payrollAllocations.workspaceId, input.workspaceId),
      eq(payrollAllocations.payrollRunId, input.runId),
      eq(payrollAllocations.id, input.allocationId),
      eq(payrollAllocations.status, "recovery_pending")
    )).returning({ id: payrollAllocations.id });
    if (!allocation[0]) return false;
    const escrow = await tx.update(payrollClaimEscrows).set({
      status: "funded",
      recoveryProofContextAddresses: [],
      recoveryContextSignatures: [],
      recoverySourceAvailableBefore: null,
      recoverySourceAvailableAfter: null,
      recoveryDestinationAvailableBefore: null,
      recoveryDestinationAvailableAfter: null,
      recoverySignature: null,
      recoveryApplySignature: null,
      recoveryReason: null,
      recoveryReasonNote: null,
      updatedAt: new Date()
    }).where(and(
      eq(payrollClaimEscrows.workspaceId, input.workspaceId),
      eq(payrollClaimEscrows.allocationId, input.allocationId),
      eq(payrollClaimEscrows.status, "recovery_pending"),
      isNull(payrollClaimEscrows.recoverySignature)
    )).returning({ allocationId: payrollClaimEscrows.allocationId });
    return Boolean(escrow[0]);
  });
}



export async function setPayrollClaimEscrowRecoveryBalanceSnapshot(
  db: Database,
  input: {
    workspaceId: string;
    allocationId: string;
    sourceAvailableBefore: string;
    reserveAvailableBefore: string;
  }
) {
  if (![input.sourceAvailableBefore, input.reserveAvailableBefore].every((value) =>
    /^(0|[1-9][0-9]*)$/.test(value)
  )) return { status: "invalid_balance" as const };
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(payrollClaimEscrows).where(and(
      eq(payrollClaimEscrows.workspaceId, input.workspaceId),
      eq(payrollClaimEscrows.allocationId, input.allocationId)
    )).for("update").limit(1);
    const escrow = rows[0];
    if (!escrow) return { status: "not_found" as const };
    if (escrow.status !== "recovery_pending" || escrow.recoverySignature !== null) {
      return { status: "conflict" as const };
    }
    if (escrow.recoverySourceAvailableBefore !== null ||
        escrow.recoveryDestinationAvailableBefore !== null) {
      return escrow.recoverySourceAvailableBefore === input.sourceAvailableBefore &&
        escrow.recoveryDestinationAvailableBefore === input.reserveAvailableBefore
        ? { status: "duplicate" as const }
        : { status: "conflict" as const };
    }
    const updated = await tx.update(payrollClaimEscrows).set({
      recoverySourceAvailableBefore: input.sourceAvailableBefore,
      recoveryDestinationAvailableBefore: input.reserveAvailableBefore,
      updatedAt: new Date()
    }).where(and(
      eq(payrollClaimEscrows.workspaceId, input.workspaceId),
      eq(payrollClaimEscrows.allocationId, input.allocationId),
      eq(payrollClaimEscrows.status, "recovery_pending"),
      isNull(payrollClaimEscrows.recoverySignature),
      isNull(payrollClaimEscrows.recoverySourceAvailableBefore),
      isNull(payrollClaimEscrows.recoveryDestinationAvailableBefore)
    )).returning({ allocationId: payrollClaimEscrows.allocationId });
    return updated[0] ? { status: "prepared" as const } : { status: "conflict" as const };
  });
}

/** A failed transfer may be released only when both owner-decrypted balances prove no value moved. */
export async function resetFailedPayrollRecoveryAttempt(
  db: Database,
  input: {
    workspaceId: string;
    runId: string;
    allocationId: string;
    signature: string;
    sourceAvailableAfter: string;
    reserveAvailableAfter: string;
  }
) {
  const balances = [input.sourceAvailableAfter, input.reserveAvailableAfter];
  if (!balances.every((value) => /^(0|[1-9][0-9]*)$/.test(value))) return false;
  return db.transaction(async (tx) => {
    const reserveRows = await tx.select({ workspaceId: workspaceReserves.workspaceId })
      .from(workspaceReserves)
      .where(eq(workspaceReserves.workspaceId, input.workspaceId))
      .for("update")
      .limit(1);
    if (!reserveRows[0]) return false;
    const escrowRows = await tx.select().from(payrollClaimEscrows).where(and(
      eq(payrollClaimEscrows.workspaceId, input.workspaceId),
      eq(payrollClaimEscrows.payrollRunId, input.runId),
      eq(payrollClaimEscrows.allocationId, input.allocationId)
    )).for("update").limit(1);
    const escrow = escrowRows[0];
    if (!escrow || escrow.status !== "recovery_pending" ||
        escrow.recoverySignature !== input.signature ||
        escrow.recoverySourceAvailableBefore !== input.sourceAvailableAfter ||
        escrow.recoveryDestinationAvailableBefore !== input.reserveAvailableAfter) return false;
    const allocationRows = await tx.select({ status: payrollAllocations.status })
      .from(payrollAllocations).where(and(
        eq(payrollAllocations.workspaceId, input.workspaceId),
        eq(payrollAllocations.payrollRunId, input.runId),
        eq(payrollAllocations.id, input.allocationId)
      )).for("update").limit(1);
    if (allocationRows[0]?.status !== "recovery_pending") return false;
    const updatedAllocation = await tx.update(payrollAllocations).set({
      status: "unclaimed",
      updatedAt: new Date()
    }).where(and(
      eq(payrollAllocations.workspaceId, input.workspaceId),
      eq(payrollAllocations.payrollRunId, input.runId),
      eq(payrollAllocations.id, input.allocationId),
      eq(payrollAllocations.status, "recovery_pending")
    )).returning({ id: payrollAllocations.id });
    if (!updatedAllocation[0]) return false;
    const updatedEscrow = await tx.update(payrollClaimEscrows).set({
      status: "funded",
      recoverySignature: null,
      recoveryProofContextAddresses: [],
      recoveryContextSignatures: [],
      recoverySourceAvailableBefore: null,
      recoverySourceAvailableAfter: null,
      recoveryDestinationAvailableBefore: null,
      recoveryDestinationAvailableAfter: null,
      recoveryApplySignature: null,
      recoveryReason: null,
      recoveryReasonNote: null,
      updatedAt: new Date()
    }).where(and(
      eq(payrollClaimEscrows.workspaceId, input.workspaceId),
      eq(payrollClaimEscrows.allocationId, input.allocationId),
      eq(payrollClaimEscrows.status, "recovery_pending"),
      eq(payrollClaimEscrows.recoverySignature, input.signature)
    )).returning({ allocationId: payrollClaimEscrows.allocationId });
    return Boolean(updatedEscrow[0]);
  });
}

export async function clearPayrollClaimEscrowRecoveryApplySignature(
  db: Database,
  input: { workspaceId: string; allocationId: string; signature: string }
) {
  const updated = await db.update(payrollClaimEscrows).set({
    recoveryApplySignature: null,
    updatedAt: new Date()
  }).where(and(
    eq(payrollClaimEscrows.workspaceId, input.workspaceId),
    eq(payrollClaimEscrows.allocationId, input.allocationId),
    eq(payrollClaimEscrows.status, "recovery_pending"),
    eq(payrollClaimEscrows.recoveryApplySignature, input.signature)
  )).returning({ allocationId: payrollClaimEscrows.allocationId });
  return Boolean(updated[0]);
}

export async function setPayrollClaimEscrowProofContexts(
  db: Database,
  input: {
    workspaceId: string;
    allocationId: string;
    phase: "funding" | "recovery";
    addresses: string[];
  }
) {
  const addresses = [...new Set(input.addresses)];
  if (addresses.length === 0 || addresses.length > 4 ||
      addresses.some((value) => typeof value !== "string" || value.length < 32 || value.length > 64)) {
    return false;
  }
  const fields = input.phase === "funding"
    ? { addressesColumn: payrollClaimEscrows.fundingProofContextAddresses, status: "funding" }
    : { addressesColumn: payrollClaimEscrows.recoveryProofContextAddresses, status: "recovery_pending" };
  const current = await getPayrollClaimEscrow(db, input.workspaceId, input.allocationId);
  if (!current || current.status !== fields.status) return false;
  const existing = input.phase === "funding"
    ? current.fundingProofContextAddresses
    : current.recoveryProofContextAddresses;
  if (existing.length > 0 && JSON.stringify(existing) !== JSON.stringify(addresses)) return false;
  const updated = await db.update(payrollClaimEscrows).set({
    ...(input.phase === "funding"
      ? { fundingProofContextAddresses: addresses }
      : { recoveryProofContextAddresses: addresses }),
    updatedAt: new Date()
  }).where(and(
    eq(payrollClaimEscrows.workspaceId, input.workspaceId),
    eq(payrollClaimEscrows.allocationId, input.allocationId),
    eq(payrollClaimEscrows.status, fields.status)
  )).returning({ allocationId: payrollClaimEscrows.allocationId });
  return Boolean(updated[0]);
}

export async function appendPayrollClaimEscrowContextSignature(
  db: Database,
  input: {
    workspaceId: string;
    allocationId: string;
    phase: "funding" | "recovery";
    signature: string;
  }
) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(input.signature)) return false;
  return db.transaction(async (tx) => {
    const rows = await tx.select().from(payrollClaimEscrows).where(and(
      eq(payrollClaimEscrows.workspaceId, input.workspaceId),
      eq(payrollClaimEscrows.allocationId, input.allocationId)
    )).for("update").limit(1);
    const escrow = rows[0];
    if (!escrow) return false;
    const validStatus = input.phase === "funding" ? escrow.status === "funding" :
      escrow.status === "recovery_pending";
    if (!validStatus) return false;
    const existing = input.phase === "funding"
      ? escrow.fundingContextSignatures
      : escrow.recoveryContextSignatures;
    if (existing.includes(input.signature)) return true;
    const signatures = [...existing, input.signature];
    const updated = await tx.update(payrollClaimEscrows).set({
      ...(input.phase === "funding"
        ? { fundingContextSignatures: signatures }
        : { recoveryContextSignatures: signatures }),
      updatedAt: new Date()
    }).where(and(
      eq(payrollClaimEscrows.workspaceId, input.workspaceId),
      eq(payrollClaimEscrows.allocationId, input.allocationId),
      eq(payrollClaimEscrows.status, escrow.status)
    )).returning({ allocationId: payrollClaimEscrows.allocationId });
    return Boolean(updated[0]);
  });
}

export async function clearPayrollClaimEscrowProofContexts(
  db: Database,
  input: {
    workspaceId: string;
    allocationId: string;
    phase: "funding" | "recovery";
  }
) {
  const escrow = await getPayrollClaimEscrow(db, input.workspaceId, input.allocationId);
  if (!escrow) return false;
  const allowed = input.phase === "funding"
    ? ["funding", "funded", "settlement_pending", "claimed", "recovery_pending", "recovered"].includes(escrow.status)
    : ["recovery_pending", "recovered"].includes(escrow.status);
  if (!allowed) return false;
  const updated = await db.update(payrollClaimEscrows).set({
    ...(input.phase === "funding"
      ? { fundingProofContextAddresses: [] }
      : { recoveryProofContextAddresses: [] }),
    updatedAt: new Date()
  }).where(and(
    eq(payrollClaimEscrows.workspaceId, input.workspaceId),
    eq(payrollClaimEscrows.allocationId, input.allocationId),
    eq(payrollClaimEscrows.status, escrow.status)
  )).returning({ allocationId: payrollClaimEscrows.allocationId });
  return Boolean(updated[0]);
}

export async function attachPayrollClaimEscrowRecoveryApplySignature(
  db: Database,
  input: { workspaceId: string; allocationId: string; signature: string }
) {
  if (!/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(input.signature)) return false;
  const updated = await db.update(payrollClaimEscrows).set({
    recoveryApplySignature: input.signature,
    updatedAt: new Date()
  }).where(and(
    eq(payrollClaimEscrows.workspaceId, input.workspaceId),
    eq(payrollClaimEscrows.allocationId, input.allocationId),
    inArray(payrollClaimEscrows.status, ["recovery_pending", "recovered"]),
    or(
      isNull(payrollClaimEscrows.recoveryApplySignature),
      eq(payrollClaimEscrows.recoveryApplySignature, input.signature)
    )
  )).returning({ allocationId: payrollClaimEscrows.allocationId });
  if (updated[0]) return true;
  const escrow = await getPayrollClaimEscrow(db, input.workspaceId, input.allocationId);
  return Boolean(escrow && escrow.recoveryApplySignature === input.signature);
}
