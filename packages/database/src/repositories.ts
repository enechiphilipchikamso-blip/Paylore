import {
  and,
  asc,
  eq,
  gt,
  isNull,
  sql
} from "drizzle-orm";
import {
  randomUUID
} from "node:crypto";
import type {
  Database
} from "./client";
import {
  authChallenges,
  invitationEntryTargets,
  sessions,
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
        workspaceId:
          invitationEntryTargets.workspaceId,
        workspaceName:
          workspaces.name,
        contributorWalletAddress:
          invitationEntryTargets.contributorWalletAddress,
        expiresAt:
          invitationEntryTargets.expiresAt
      })
      .from(
        invitationEntryTargets
      )
      .innerJoin(
        workspaces,
        eq(
          invitationEntryTargets.workspaceId,
          workspaces.id
        )
      )
      .where(
        and(
          eq(
            invitationEntryTargets.tokenHash,
            tokenHash
          ),
          gt(
            invitationEntryTargets.expiresAt,
            now
          )
        )
      )
      .limit(1);

  return rows[0] ?? null;
}