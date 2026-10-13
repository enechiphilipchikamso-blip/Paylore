import { NextResponse } from "next/server";
import { acceptContributorInvitation } from "@paylore/database";
import { clearSessionCookie, getSessionState } from "../../../../../server/session";
import {
  assertSameOrigin,
  hashOpaqueToken,
  RequestSecurityError
} from "../../../../../server/security";
import { getDatabase } from "../../../../../server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  try {
    assertSameOrigin(request);
    const { token } = await params;
    const session = await getSessionState();
    if (session.status !== "authenticated") {
      await clearSessionCookie();
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }

    const result = await acceptContributorInvitation(
      getDatabase(),
      {
        tokenHash: hashOpaqueToken(token),
        userId: session.session.userId,
        walletAddress: session.session.walletAddress
      }
    );
    if (!result) {
      return NextResponse.json({ error: "invitation_unavailable" }, { status: 409 });
    }

    return NextResponse.json({
      status: "accepted",
      workspaceId: result.workspaceId,
      workspacePath: `/workspace/${result.workspaceId}`
    });
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return NextResponse.json({ error: "request_not_allowed" }, { status: 403 });
    }
    if (
      error instanceof Error &&
      error.message === "The authenticated wallet does not match this invitation."
    ) {
      return NextResponse.json({ error: "invitation_wallet_mismatch" }, { status: 403 });
    }
    console.error(JSON.stringify({ event: "contributor_invitation_accept_failed" }));
    return NextResponse.json({ error: "invitation_could_not_be_accepted" }, { status: 500 });
  }
}
