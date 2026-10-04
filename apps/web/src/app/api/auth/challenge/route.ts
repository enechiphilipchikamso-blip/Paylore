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
  isValidSolanaAddress
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

    const body =
      await request.json();

    const parsed =
      challengeSchema.safeParse(body);

    if (!parsed.success) {
      return NextResponse.json(
        {
          error:
            "invalid_request"
        },
        { status: 400 }
      );
    }

    if (
      !isValidSolanaAddress(
        parsed.data.walletAddress
      )
    ) {
      return NextResponse.json(
        {
          error:
            "invalid_wallet_address"
        },
        { status: 400 }
      );
    }

    const issuedAt = new Date();

    const expirationTime =
      new Date(
        issuedAt.getTime() +
          AUTH_CHALLENGE_TTL_MS
      );

    const nonce =
      randomBytes(32).toString(
        "hex"
      );

    const challenge =
      buildChallenge({
        walletAddress:
          parsed.data.walletAddress,
        nonce,
        issuedAt,
        expirationTime,
        requestUrl:
          request.url
      });

    await insertAuthChallenge(
      getDatabase(),
      {
        nonce,
        walletAddress:
          parsed.data.walletAddress,
        challengeInput:
          challenge.input,
        message:
          challenge.message,
        issuedAt,
        expirationTime
      }
    );

    return NextResponse.json({
      nonce,
      input: challenge.input,
      message: challenge.message
    });
  } catch {
    return NextResponse.json(
      {
        error: "invalid_request"
      },
      { status: 403 }
    );
  }
}