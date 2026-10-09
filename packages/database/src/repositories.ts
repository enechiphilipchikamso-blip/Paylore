import {
  and,
  asc,
  desc,
  eq,
  gt,
  isNull,
  lte,
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
  contributorInvitations,
  contributors,
  authChallenges,
  invitationEntryTargets,
  sessions,
  subscriptionPayments,
  workspaceReserves,
  workspaceSubscriptions,
  users,
  walletIdentities,
  workspaceCreationRateLimits,
  workspaceMemberships,
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
  workspaceId: string
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

  return rows[0] ?? null;
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
    lifecycle: "invited" | "active" | "left";
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
  const rows =
    await db
      .insert(workspaceReserves)
      .values(input)
      .onConflictDoNothing({
        target: workspaceReserves.workspaceId
      })
      .returning();

  if (rows[0]) {
    return {
      reserve: rows[0],
      created: true
    };
  }

  const existing =
    await getWorkspaceReserve(db, input.workspaceId);
  if (!existing) {
    throw new Error(
      "Workspace reserve could not be created or retrieved."
    );
  }

  return {
    reserve: existing,
    created: false
  };
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