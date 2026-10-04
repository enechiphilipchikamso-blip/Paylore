import { NextResponse } from "next/server";
import {
  clearSessionCookie,
  getSessionState
} from "../../../../server/session";

export const runtime = "nodejs";
export const dynamic =
  "force-dynamic";

export async function GET() {
  const state =
    await getSessionState();

  if (
    state.status ===
    "authenticated"
  ) {
    return NextResponse.json({
      authenticated: true,
      walletAddress:
        state.session.walletAddress,
      issuedAt:
        state.session.issuedAt.toISOString(),
      lastSeenAt:
        state.session.lastSeenAt.toISOString(),
      expiresAt:
        state.session.expiresAt.toISOString()
    });
  }

  if (
    state.status ===
      "inactivity_expired" ||
    state.status ===
      "hard_expired"
  ) {
    await clearSessionCookie();

    return NextResponse.json(
      {
        authenticated: false,
        reason:
          state.status
      },
      { status: 401 }
    );
  }

  await clearSessionCookie();

  return NextResponse.json(
    {
      authenticated: false
    },
    { status: 401 }
  );
}