import { NextResponse } from "next/server";
import {
  clearSessionCookie,
  revokeCurrentSession
} from "../../../../server/session";
import {
  assertSameOrigin
} from "../../../../server/security";

export const runtime = "nodejs";

export async function POST(
  request: Request
) {
  try {
    assertSameOrigin(request);

    await revokeCurrentSession();
    await clearSessionCookie();

    return NextResponse.json({
      authenticated: false
    });
  } catch {
    return NextResponse.json(
      {
        error: "request_rejected"
      },
      { status: 403 }
    );
  }
}