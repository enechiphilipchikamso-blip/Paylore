import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getWorkspaceForUser,
  getWorkspaceReserve,
  getWorkspaceSubscription
} from "@paylore/database";
import { clearSessionCookie, getSessionState } from "../../../../../../server/session";
import { assertSameOrigin, RequestSecurityError } from "../../../../../../server/security";
import { getDatabase } from "../../../../../../server/db";
import {
  initializeWorkspaceReserve,
  verifyAndRestoreWorkspaceReserve
} from "../../../../../../server/reserve";

const reserveActionSchema = z.object({
  action: z.enum(["initialize", "restore"]).default("initialize")
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authorized(workspaceId: string) {
  const session = await getSessionState();
  if (session.status !== "authenticated") {
    await clearSessionCookie();
    return { response: NextResponse.json({ error: "authentication_required" }, { status: 401 }) };
  }
  const db = getDatabase();
  const membership = await getWorkspaceForUser(db, session.session.userId, workspaceId);
  if (!membership || membership.role !== "organization_admin") {
    return { response: NextResponse.json({ error: "workspace_access_denied" }, { status: 403 }) };
  }
  return { db };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const access = await authorized(workspaceId);
  if ("response" in access) return access.response;
  const reserve = await getWorkspaceReserve(access.db, workspaceId);
  return NextResponse.json({
    reserve: reserve
      ? {
          address: reserve.address,
          createdAt: reserve.createdAt,
          updatedAt: reserve.updatedAt
        }
      : null
  });
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    assertSameOrigin(request);
    const { workspaceId } = await params;
    const access = await authorized(workspaceId);
    if ("response" in access) return access.response;
    const subscription = await getWorkspaceSubscription(access.db, workspaceId);
    if (subscription?.status !== "active" && subscription?.status !== "cancel_scheduled") {
      return NextResponse.json({ error: "workspace_read_only" }, { status: 409 });
    }
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid_reserve_action" }, { status: 400 });
    }
    const parsed = reserveActionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_reserve_action" }, { status: 400 });
    }
    const reserve =
      parsed.data.action === "restore"
        ? await verifyAndRestoreWorkspaceReserve(access.db, workspaceId)
        : await initializeWorkspaceReserve(access.db, workspaceId);
    return NextResponse.json({
      status: "ready",
      address: reserve.address,
      created: "created" in reserve ? reserve.created : false,
      restoredAt: "restoredAt" in reserve ? reserve.restoredAt : null
    });
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return NextResponse.json({ error: "request_not_allowed" }, { status: 403 });
    }
    if (
      error instanceof Error &&
      error.message === "WORKSPACE_DELETION_PENDING"
    ) {
      return NextResponse.json(
        { error: "workspace_deletion_pending" },
        { status: 409 }
      );
    }
    console.error(JSON.stringify({ event: "workspace_reserve_initialization_failed" }));
    return NextResponse.json({ error: "reserve_initialization_failed" }, { status: 503 });
  }
}
