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
  CONTRIBUTOR_ASSOCIATION_CLEANUP_DELAY_MS,
  hasReachedInactivityThreshold,
  isContributorAssociationCleanupEligible,
  isWorkspaceRetentionEligible,
  scheduleWorkspaceDeletion
} from "./retention-policy";
import {
  contributorInvitations,
  payrollAllocations,
  payrollRecoveries,
  payrollRuns,
  solanaWebhookEvents,
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
  if (!invitation || invitation.expiresAt <= now) {
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
    signature?: string | null;
    now?: Date;
  }
) {
  const now = input.now ?? new Date();
  const conditions = [
    eq(subscriptionPaymentAttempts.id, input.attemptId)
  ];
  if (input.signature !== undefined) {
    conditions.push(
      input.signature === null
        ? isNull(subscriptionPaymentAttempts.signature)
        : eq(subscriptionPaymentAttempts.signature, input.signature)
    );
  }
  const rows = await db
    .update(subscriptionPaymentAttempts)
    .set({ status: input.status, updatedAt: now })
    .where(and(...conditions))
    .returning();
  return rows[0] ?? null;
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

    const currentPaymentStart =
      current.periodEnd &&
      current.periodEnd > now &&
      (current.status === "active" ||
        current.status === "cancel_scheduled")
        ? current.periodEnd
        : now;
    const nextPeriodEnd =
      addCalendarMonth(currentPaymentStart);

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
          periodStart:
            current.status === "active" &&
            current.periodEnd &&
            current.periodEnd > now
              ? current.periodStart
              : currentPaymentStart,
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
  return db
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
    .limit(Math.min(Math.max(limit, 1), 100));
}

export async function markUserNotificationRead(
  db: Database,
  input: { recipientKey: string; notificationId: string; now?: Date }
) {
  const rows = await db
    .update(workspaceNotifications)
    .set({ readAt: input.now ?? new Date() })
    .where(
      and(
        eq(workspaceNotifications.id, input.notificationId),
        eq(workspaceNotifications.recipientKey, input.recipientKey),
        isNull(workspaceNotifications.readAt)
      )
    )
    .returning({ id: workspaceNotifications.id });
  return rows[0] ?? null;
}

export async function markAllUserNotificationsRead(
  db: Database,
  input: { recipientKey: string; now?: Date }
) {
  const rows = await db
    .update(workspaceNotifications)
    .set({ readAt: input.now ?? new Date() })
    .where(
      and(
        eq(workspaceNotifications.recipientKey, input.recipientKey),
        isNull(workspaceNotifications.readAt)
      )
    )
    .returning({ id: workspaceNotifications.id });
  return rows.length;
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
): Promise<"completed" | "outstanding_obligations" | "not_found"> {
  const now = input.now ?? new Date();
  return db.transaction(async (tx) => {
    const matchingContributor = await tx
      .select({ id: contributors.id })
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
    if (matchingContributor.length === 0) return "not_found";

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
        manualAccountClose: Boolean(input.closeTransactionSignature),
        closeTransactionSignature: input.closeTransactionSignature,
        associationRemovedAt: now,
        status: "completed"
      })
      .onConflictDoUpdate({
        target: contributorOffboarding.contributorId,
        set: {
          completedAt: now,
          manualAccountClose: Boolean(input.closeTransactionSignature),
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
        manualAccountClose: Boolean(input.closeTransactionSignature)
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
      body: "Workspace access has been removed. Your confidential account remains under your control.",
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
      if (openAllocations.length > 0) {
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
      if (recipient) {
        await tx
          .insert(workspaceNotifications)
          .values({
            workspaceId: candidate.workspaceId,
            recipientKey: recipient,
            eventKey: `contributor-association-cleanup:${contributor.id}`,
            category: "Recovery & Offboarding",
            title: "Workspace association removed",
            body: "Workspace access has been removed after the retention period. Your confidential account has not been closed by Paylore.",
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

      await tx
        .insert(contributorOffboarding)
        .values({
          contributorId: contributor.id,
          workspaceId: candidate.workspaceId,
          completedAt: now,
          manualAccountClose: false,
          automaticCleanupEligibleAt: eligibleAt,
          associationRemovedAt: now,
          status: "completed"
        })
        .onConflictDoUpdate({
          target: contributorOffboarding.contributorId,
          set: {
            completedAt: now,
            manualAccountClose: false,
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
          metadata: { manualAccountClose: false },
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
          lifecycle: contributors.lifecycle
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
    if (!contributor || contributor.lifecycle === "left") {
      throw new Error(
        "Contributor is not eligible for an invitation."
      );
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
            contributors.identityWalletAddress
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
      invitation.acceptedAt
    ) {
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
          role: "contributor"
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
        "contributor"
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
      .where(
        eq(contributors.id, invitation.contributorId)
      );

    return {
      workspaceId: invitation.workspaceId,
      contributorId: invitation.contributorId
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
      claimId: payrollAllocations.claimId,
      claimAddress: payrollAllocations.claimAddress,
      status: payrollAllocations.status,
      transactionSignature: payrollAllocations.transactionSignature,
      claimedAt: payrollAllocations.claimedAt,
      recoveredAt: payrollAllocations.recoveredAt,
      createdAt: payrollAllocations.createdAt,
      updatedAt: payrollAllocations.updatedAt
    })
    .from(payrollAllocations)
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
    claims: Array<{
      claimId: string;
      claimAddress: string;
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
      run.status !== "committed"
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

    const byClaimId = new Map(input.claims.map((claim) => [claim.claimId, claim]));
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
          allocationCommitment: run.allocationCommitment
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
    now?: Date;
  }
) {
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
      .where(
        and(
          eq(payrollAllocations.id, input.allocationId),
          eq(payrollAllocations.workspaceId, input.workspaceId),
          eq(payrollAllocations.payrollRunId, input.runId)
        )
      )
      .for("update")
      .limit(1);
    const allocation = allocationRows[0];
    if (!allocation) return { status: "not_found" as const };

    const existingRows = await tx
      .select()
      .from(payrollRecoveries)
      .where(eq(payrollRecoveries.allocationId, input.allocationId))
      .limit(1);
    const existing = existingRows[0];
    if (existing) {
      if (
        allocation.status === "recovered" &&
        existing.status === "confirmed" &&
        existing.transactionSignature === input.signature &&
        existing.reason === input.reason &&
        existing.reasonNote === input.reasonNote
      ) {
        return { status: "duplicate" as const };
      }
      return { status: "conflict" as const };
    }
    if (
      allocation.status !== "unclaimed" ||
      allocation.claimAddress !== input.claimAddress
    ) {
      return { status: "conflict" as const };
    }

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
      .onConflictDoNothing({
        target: payrollRecoveries.allocationId
      })
      .returning({ id: payrollRecoveries.id });
    if (!recoveryRows[0]) return { status: "conflict" as const };

    const updated = await tx
      .update(payrollAllocations)
      .set({
        status: "recovered",
        recoveredAt: now,
        transactionSignature: input.signature,
        updatedAt: now
      })
      .where(
        and(
          eq(payrollAllocations.id, input.allocationId),
          eq(payrollAllocations.workspaceId, input.workspaceId),
          eq(payrollAllocations.status, "unclaimed"),
          eq(payrollAllocations.claimAddress, input.claimAddress)
        )
      )
      .returning({ id: payrollAllocations.id });
    if (!updated[0]) {
      throw new Error("The payroll allocation changed during recovery reconciliation.");
    }

    await tx
      .insert(workspaceLedgerEntries)
      .values({
        workspaceId: input.workspaceId,
        idempotencyKey: `payroll-recovery:${input.allocationId}`,
        category: "recovery",
        entryType: "claim_entitlement_cancelled",
        status: "finalized",
        referenceType: "payroll_allocation",
        referenceId: input.allocationId,
        transactionSignature: input.signature,
        metadata: {
          runId: input.runId,
          claimId: allocation.claimId,
          reason: input.reason,
          cancelledEntitlementBaseUnits: allocation.amountBaseUnits,
          valueTransferred: false
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
      .values(
        contributorUsers.map((contributor) => ({
          workspaceId: input.workspaceId,
          recipientKey: contributor.userId,
          eventKey: `payroll-recovery:${input.allocationId}`,
          category: "Recovery & Offboarding",
          title: "A payroll allocation was recovered",
          body: "An unclaimed payroll entitlement was marked recovered on Devnet. Contact the workspace administrator if you believe this was made in error.",
          destination: `/workspace/${input.workspaceId}/compensation`,
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
          eventKey: `payroll-recovery:${input.allocationId}`,
          category: "Recovery & Offboarding",
          title: "Payroll recovery finalized",
          body: "An unclaimed Claim PDA transitioned to RECOVERED. This ledger entry records the entitlement state, not a public USDC transfer.",
          destination: `/workspace/${input.workspaceId}/ledger`,
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
      amountBaseUnits: payrollAllocations.amountBaseUnits,
      contributorWalletAddress: contributors.identityWalletAddress,
      allocationCommitment: payrollRuns.allocationCommitment,
      recoveryStatus: payrollRecoveries.status,
      recoverySignature: payrollRecoveries.transactionSignature
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

    if (entries[0]) {
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
    }
    return { status: entries[0] ? "recorded" as const : "duplicate" as const };
  });
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
        feeLamports: gasTankOperations.feeLamports
      })
      .from(gasTankOperations)
      .where(and(
        eq(gasTankOperations.workspaceId, input.workspaceId),
        gte(gasTankOperations.createdAt, input.since)
      ))
      .limit(1001);
    if (recent.length > 1000) {
      return { status: "gas_tank_daily_sponsorship_limit" as const, operation: existing ?? null };
    }
    let dailyFees = 0n;
    let dailyOperations = 0;
    let reservedFees = 0n;
    for (const row of recent) {
      if (!["preparing", "prepared", "finalized"].includes(row.status)) continue;
      dailyOperations += 1;
      const amount = row.feeLamports && positiveInteger(row.feeLamports)
        ? BigInt(row.feeLamports)
        : row.status === "preparing" || row.status === "prepared"
          ? BigInt(input.reservedFeeLamports)
          : 0n;
      dailyFees += amount;
      if (row.status === "preparing" || row.status === "prepared") {
        reservedFees += amount;
      }
    }

    const available = BigInt(input.availableBalanceLamports);
    const requestedReservation = BigInt(input.reservedFeeLamports);
    if (available < reservedFees + requestedReservation) {
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
    transactionSignature?: string | null;
    feeLamports?: string | null;
    failureCode?: string | null;
  }
): Promise<boolean> {
  const previousStatuses =
    input.status === "prepared" || input.status === "failed"
      ? ["preparing"]
      : input.status === "cancelled"
        ? ["preparing", "prepared"]
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
      updatedAt: new Date()
    })
    .where(and(
      eq(gasTankOperations.id, input.operationId),
      eq(gasTankOperations.workspaceId, input.workspaceId),
      inArray(gasTankOperations.status, previousStatuses)
    ))
    .returning({ id: gasTankOperations.id });
  if (update[0]) return true;

  const rows = await db
    .select({
      status: gasTankOperations.status,
      transactionSignature: gasTankOperations.transactionSignature
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
      rows[0].transactionSignature === input.transactionSignature)
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
      feeLamports: gasTankOperations.feeLamports
    })
    .from(gasTankOperations)
    .where(and(
      eq(gasTankOperations.workspaceId, workspaceId),
      gte(gasTankOperations.createdAt, since)
    ))
    .limit(1001);
  const overflow = rows.length > 1000;
  let feeLamports = 0n;
  let operationCount = 0;
  for (const row of rows) {
    if (!["preparing", "prepared", "finalized"].includes(row.status)) continue;
    operationCount += 1;
    if (row.feeLamports && /^(0|[1-9][0-9]*)$/.test(row.feeLamports)) {
      feeLamports += BigInt(row.feeLamports);
    } else if (row.status === "preparing" || row.status === "prepared") {
      feeLamports += 100_000n;
    }
  }
  return { feeLamports, operationCount, overflow };
}
