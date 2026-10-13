import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getWorkspaceForUser,
  getWorkspaceSubscription,
  updateContributorLifecycle
} from "@paylore/database";
import { clearSessionCookie, getSessionState } from "../../../../../../server/session";
import { assertSameOrigin, RequestSecurityError } from "../../../../../../server/security";
import { getDatabase } from "../../../../../../server/db";

const lifecycleSchema = z.object({
  lifecycle: z.enum(["invited", "active"])
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(
  request: Request,
  {
    params
  }: {
    params: Promise<{ workspaceId: string; contributorId: string }>;
  }
) {
  try {
    assertSameOrigin(request);
    const { workspaceId, contributorId } = await params;
    const session = await getSessionState();
    if (session.status !== "authenticated") {
      await clearSessionCookie();
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }
    const db = getDatabase();
    const membership = await getWorkspaceForUser(db, session.session.userId, workspaceId);
    if (!membership || membership.role !== "organization_admin") {
      return NextResponse.json({ error: "workspace_access_denied" }, { status: 403 });
    }
    const subscription = await getWorkspaceSubscription(db, workspaceId);
    if (subscription?.status !== "active" && subscription?.status !== "cancel_scheduled") {
      return NextResponse.json({ error: "workspace_read_only" }, { status: 409 });
    }
    const parsed = lifecycleSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_contributor_update" }, { status: 400 });
    }
    const contributor = await updateContributorLifecycle(db, {
      workspaceId,
      contributorId,
      lifecycle: parsed.data.lifecycle
    });
    if (!contributor) {
      return NextResponse.json({ error: "contributor_not_found" }, { status: 404 });
    }
    return NextResponse.json({ contributor });
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return NextResponse.json({ error: "request_not_allowed" }, { status: 403 });
    }
    console.error(JSON.stringify({ event: "contributor_update_failed" }));
    return NextResponse.json({ error: "contributor_update_failed" }, { status: 500 });
  }
}
