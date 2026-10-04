import "server-only";

import { cookies } from "next/headers";
import { randomBytes } from "node:crypto";
import {
  findSessionByTokenHash,
  revokeSessionById,
  revokeSessionByTokenHash,
  touchSession,
  type Database
} from "@paylore/database";
import { getDatabase } from "./db";
import { hashOpaqueToken } from "./security";

export const SESSION_INACTIVITY_MS =
  12 * 60 * 60 * 1000;

export const SESSION_HARD_LIFETIME_MS =
  7 * 24 * 60 * 60 * 1000;

export type SessionEvaluation =
  | {
      status: "authenticated";
    }
  | {
      status: "inactivity_expired";
    }
  | {
      status: "hard_expired";
    };

export function evaluateSession(
  input: {
    issuedAt: Date;
    lastSeenAt: Date;
    expiresAt: Date;
  },
  now: Date
): SessionEvaluation {
  if (
    now.getTime() >=
    input.expiresAt.getTime()
  ) {
    return {
      status: "hard_expired"
    };
  }

  if (
    now.getTime() -
      input.lastSeenAt.getTime() >=
    SESSION_INACTIVITY_MS
  ) {
    return {
      status: "inactivity_expired"
    };
  }

  return {
    status: "authenticated"
  };
}

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
  const tokenHash = hashOpaqueToken(rawToken);
  const issuedAt = new Date();
  const expiresAt = new Date(
    issuedAt.getTime() +
      SESSION_HARD_LIFETIME_MS
  );

  await db.insert(
    await import("@paylore/database").then(
      ({ sessions }) => sessions
    )
  );

  return {
    rawToken,
    issuedAt,
    expiresAt
  };
}