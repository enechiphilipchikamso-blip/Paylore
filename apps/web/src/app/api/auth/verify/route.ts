import { NextResponse } from "next/server";
import { z } from "zod";
import {
  consumeAuthChallenge,
  findAuthChallenge,
  findOrCreateUserWalletIdentity,
  revokeSessionByTokenHash
} from "@paylore/database";
import {
  verifyWalletProof
} from "../../../../server/auth/verification";
import {
  getDatabase
} from "../../../../server/db";
import {
  createServerSession,
  getSessionTokenFromCookies,
  persistSessionCookie
} from "../../../../server/session";
import {
  assertSameOrigin,
  getRequestOrigin,
  hashOpaqueToken,
  isValidSolanaAddress,
  RequestSecurityError
} from "../../../../server/security";

const verifySchema = z.object({
  nonce: z
    .string()
    .regex(/^[a-f0-9]{64}$/),

  walletAddress: z
    .string()
    .min(32)
    .max(64),

  publicKey: z
    .string()
    .min(4)
    .max(512),

  chains: z
    .array(z.string())
    .min(1),

  features: z
    .array(z.string()),

  signedMessage: z
    .string()
    .min(1)
    .max(16384),

  signature: z
    .string()
    .min(16)
    .max(16384)
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
        "[auth.verify] Rejected request origin.",
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
      { error: "authentication_failed" },
      { status: 401 }
    );
  }

  const parsed =
    verifySchema.safeParse(body);

  if (
    !parsed.success ||
    !isValidSolanaAddress(
      parsed.data.walletAddress
    )
  ) {
    return NextResponse.json(
      { error: "authentication_failed" },
      { status: 401 }
    );
  }

  try {
    const db = getDatabase();
    const challenge =
      await findAuthChallenge(
        db,
        parsed.data.nonce
      );

    if (
      !challenge ||
      challenge.consumedAt ||
      challenge.expirationTime.getTime() <=
        Date.now() ||
      challenge.walletAddress !==
        parsed.data.walletAddress
    ) {
      return NextResponse.json(
        { error: "authentication_failed" },
        { status: 401 }
      );
    }

    const challengeInput =
      challenge.input as import("@solana/wallet-standard-features").SolanaSignInInput;

    const valid =
      await verifyWalletProof(
        {
          challengeInput,
          expectedAuthUrl: new URL(
            "/auth",
            getRequestOrigin(request)
          ).toString()
        },
        {
          walletAddress: parsed.data.walletAddress,
          account: {
            address: parsed.data.walletAddress,
            publicKey: parsed.data.publicKey,
            chains: parsed.data.chains,
            features: parsed.data.features
          },
          signedMessage: parsed.data.signedMessage,
          signature: parsed.data.signature
        }
      );

    if (!valid) {
      return NextResponse.json(
        { error: "authentication_failed" },
        { status: 401 }
      );
    }

    const now = new Date();
    const consumed =
      await consumeAuthChallenge(
        db,
        parsed.data.nonce,
        now
      );

    if (!consumed) {
      return NextResponse.json(
        { error: "authentication_failed" },
        { status: 401 }
      );
    }

    const identity =
      await findOrCreateUserWalletIdentity(
        db,
        parsed.data.walletAddress
      );
    const existingToken =
      await getSessionTokenFromCookies();

    if (existingToken) {
      await revokeSessionByTokenHash(
        db,
        hashOpaqueToken(existingToken),
        now
      );
    }

    const session =
      await createServerSession(
        db,
        {
          userId: identity.userId,
          walletIdentityId:
            identity.walletIdentityId
        }
      );

    await persistSessionCookie(
      session.rawToken
    );

    return NextResponse.json({
      authenticated: true,
      walletAddress: parsed.data.walletAddress
    });
  } catch (cause) {
    console.error(
      "[auth.verify] Sign-in could not be completed due to a server error.",
      cause
    );

    return NextResponse.json(
      { error: "authentication_unavailable" },
      { status: 503 }
    );
  }
}