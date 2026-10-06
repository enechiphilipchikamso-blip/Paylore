import "server-only";

import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import {
  createSession,
  findSessionByTokenHash,
  revokeSessionById,
  revokeSessionByTokenHash,
  touchSession,
  type Database
} from "@paylore/database";
import { getDatabase } from "./db";
import { hashOpaqueToken } from "./security";
import {
  evaluateSession,
  SESSION_HARD_LIFETIME_MS
} from "./session-policy";

export {
  evaluateSession,
  SESSION_HARD_LIFETIME_MS,
  SESSION_INACTIVITY_MS
} from "./session-policy";

export type { SessionEvaluation } from "./session-policy";

function cookieNameForEnvironment(
  nodeEnv: string | undefined
): string {
  return nodeEnv === "production"
    ? "__Host-paylore-session"
    : "paylore-session";
}

export function getSessionCookieName(): string {
  return cookieNameForEnvironment(
    process.env.NODE_ENV
  );
}

export async function getSessionTokenFromCookies(): Promise<
  string | null
> {
  const store = await cookies();

  return (
    store.get(getSessionCookieName())?.value ??
    null
  );
}

export async function persistSessionCookie(
  rawToken: string
): Promise<void> {
  const store = await cookies();
  const isProduction =
    process.env.NODE_ENV === "production";

  store.set({
    name: getSessionCookieName(),
    value: rawToken,
    httpOnly: true,
    secure: isProduction,
    sameSite: "lax",
    path: "/",
    maxAge:
      SESSION_HARD_LIFETIME_MS / 1000
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(getSessionCookieName());
}

export async function createServerSession(
  db: Database,
  input: {
    userId: string;
    walletIdentityId: string;
  }
): Promise<{
  rawToken: string;
  issuedAt: Date;
  expiresAt: Date;
}> {
  const rawToken =
    randomBytes(32).toString("base64url");

  const issuedAt = new Date();

  const expiresAt = new Date(
    issuedAt.getTime() +
      SESSION_HARD_LIFETIME_MS
  );

  await createSession(db, {
    rawTokenHash:
      hashOpaqueToken(rawToken),
    userId: input.userId,
    walletIdentityId:
      input.walletIdentityId,
    issuedAt,
    lastSeenAt: issuedAt,
    expiresAt
  });

  return {
    rawToken,
    issuedAt,
    expiresAt
  };
}

export type SessionState =
  | {
      status: "unauthenticated";
    }
  | {
      status: "inactivity_expired";
    }
  | {
      status: "hard_expired";
    }
  | {
      status: "authenticated";
      session: {
        sessionId: string;
        userId: string;
        walletIdentityId: string;
        walletAddress: string;
        issuedAt: Date;
        lastSeenAt: Date;
        expiresAt: Date;
      };
    };

export async function getSessionState(
  db: Database = getDatabase()
): Promise<SessionState> {
  const rawToken =
    await getSessionTokenFromCookies();

  if (!rawToken) {
    return {
      status: "unauthenticated"
    };
  }

  const session =
    await findSessionByTokenHash(
      db,
      hashOpaqueToken(rawToken)
    );

  if (!session) {
    return {
      status: "unauthenticated"
    };
  }

  const now = new Date();

  const evaluation =
    evaluateSession(
      {
        issuedAt: session.issuedAt,
        lastSeenAt: session.lastSeenAt,
        expiresAt: session.expiresAt
      },
      now
    );

  if (
    evaluation.status ===
    "hard_expired"
  ) {
    await revokeSessionById(
      db,
      session.id,
      now
    );

    return {
      status: "hard_expired"
    };
  }

  if (
    evaluation.status ===
    "inactivity_expired"
  ) {
    await revokeSessionById(
      db,
      session.id,
      now
    );

    return {
      status: "inactivity_expired"
    };
  }

  await touchSession(
    db,
    session.id,
    now
  );

  return {
    status: "authenticated",
    session: {
      sessionId: session.id,
      userId: session.userId,
      walletIdentityId:
        session.walletIdentityId,
      walletAddress:
        session.walletAddress,
      issuedAt: session.issuedAt,
      lastSeenAt: now,
      expiresAt: session.expiresAt
    }
  };
}

export async function revokeCurrentSession(
  db: Database = getDatabase()
): Promise<void> {
  const rawToken =
    await getSessionTokenFromCookies();

  if (!rawToken) {
    return;
  }

  await revokeSessionByTokenHash(
    db,
    hashOpaqueToken(rawToken),
    new Date()
  );
}