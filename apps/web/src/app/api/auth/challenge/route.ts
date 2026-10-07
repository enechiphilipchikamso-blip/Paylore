import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  insertAuthChallenge
} from "@paylore/database";
import { getDatabase } from "../../../../server/db";
import {
  AUTH_CHALLENGE_TTL_MS,
  buildChallenge
} from "../../../../server/auth/protocol";
import {
  assertSameOrigin,
  getRequestOrigin,
  isValidSolanaAddress,
  RequestSecurityError
} from "../../../../server/security";

const challengeSchema = z.object({
  walletAddress: z
    .string()
    .min(32)
    .max(64)
});

export const runtime = "nodejs";
export const dynamic =
  "force-dynamic";

export async function POST(
  request: Request
) {
  try {
    assertSameOrigin(request);
  } catch (cause) {
    if (cause instanceof RequestSecurityError) {
      console.warn(
        "[auth.challenge] Rejected request origin.",
        cause.message
      );

      return NextResponse.json(
        { error: "invalid_request" },
        { status: 403 }
      );
    }

    throw cause;
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json(
      { error: "invalid_request" },
      { status: 400 }
    );
  }

  const parsed =
    challengeSchema.safeParse(body);

  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid_request" },
      { status: 400 }
    );
  }

  if (
    !isValidSolanaAddress(
      parsed.data.walletAddress
    )
  ) {
    return NextResponse.json(
      { error: "invalid_wallet_address" },
      { status: 400 }
    );
  }

  const issuedAt = new Date();
  const expirationTime = new Date(
    issuedAt.getTime() +
      AUTH_CHALLENGE_TTL_MS
  );
  const nonce = randomBytes(32).toString("hex");
  const challenge = buildChallenge({
    walletAddress: parsed.data.walletAddress,
    nonce,
    issuedAt,
    expirationTime,
    requestUrl: getRequestOrigin(request)
  });

  try {
    await insertAuthChallenge(
      getDatabase(),
      {
        nonce,
        walletAddress: parsed.data.walletAddress,
        challengeInput: challenge.input,
        message: challenge.message,
        issuedAt,
        expirationTime
      }
    );

    return NextResponse.json({
      nonce,
      input: challenge.input,
      message: challenge.message
    });
  } catch (cause) {
    console.error(
      "[auth.challenge] Failed to persist sign-in challenge.",
      cause
    );

    return NextResponse.json(
      { error: "challenge_unavailable" },
      { status: 503 }
    );
  }
}