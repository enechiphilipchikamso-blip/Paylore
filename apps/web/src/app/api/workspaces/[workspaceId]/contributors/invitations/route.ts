import { NextResponse } from "next/server";
import { randomBytes } from "node:crypto";
import {
  createContributorInvitation,
  getWorkspaceForUser,
  getWorkspaceSubscription,
  listWorkspaceInvitations
} from "@paylore/database";
import { clearSessionCookie, getSessionState } from "../../../../../../server/session";
import {
  assertSameOrigin,
  hashOpaqueToken,
  RequestSecurityError
} from "../../../../../../server/security";
import { getDatabase } from "../../../../../../server/db";
import { z } from "zod";

const invitationSchema = z.object({
  contributorId: z.string().uuid()
});

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function accessWorkspace(workspaceId: string) {
  const session = await getSessionState();
  if (session.status !== "authenticated") {
    await clearSessionCookie();
    return { response: NextResponse.json({ error: "authentication_required" }, { status: 401 }) };
  }
  const db = getDatabase();
  const membership = await getWorkspaceForUser(db, session.session.userId, workspaceId);
  if (!membership || membership.role === "contributor") {
    return { response: NextResponse.json({ error: "workspace_access_denied" }, { status: 403 }) };
  }
  return { db, membership, session: session.session };
}

export async function GET(_request: Request, { params }: RouteContext) {
  const { workspaceId } = await params;
  const access = await accessWorkspace(workspaceId);
  if ("response" in access) return access.response;
  if (access.membership.role !== "organization_admin") {
    return NextResponse.json({ error: "workspace_access_denied" }, { status: 403 });
  }
  return NextResponse.json({
    invitations: await listWorkspaceInvitations(access.db, workspaceId)
  }, { headers: { "Cache-Control": "no-store" } });
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    assertSameOrigin(request);
    const { workspaceId } = await params;
    const access = await accessWorkspace(workspaceId);
    if ("response" in access) return access.response;
    if (access.membership.role !== "organization_admin") {
      return NextResponse.json({ error: "workspace_access_denied" }, { status: 403 });
    }
    const subscription = await getWorkspaceSubscription(access.db, workspaceId);
    if (subscription?.status !== "active" && subscription?.status !== "cancel_scheduled") {
      return NextResponse.json({ error: "workspace_read_only" }, { status: 409 });
    }
    const parsed = invitationSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_invitation" }, { status: 400 });
    }

    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    const invitation = await createContributorInvitation(access.db, {
      tokenHash: hashOpaqueToken(token),
      workspaceId,
      contributorId: parsed.data.contributorId,
      createdByUserId: access.session.userId,
      expiresAt
    });
    return NextResponse.json(
      {
        id: invitation.id,
        invitePath: `/invite/${token}`,
        expiresAt: expiresAt.toISOString()
      },
      { status: 201, headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return NextResponse.json({ error: "request_not_allowed" }, { status: 403 });
    }
    if (error instanceof Error && error.message === "Contributor is not eligible for an invitation.") {
      return NextResponse.json({ error: "contributor_not_eligible_for_invitation" }, { status: 409 });
    }
    console.error(JSON.stringify({ event: "contributor_invitation_create_failed" }));
    return NextResponse.json({ error: "invitation_could_not_be_prepared" }, { status: 500 });
  }
}
