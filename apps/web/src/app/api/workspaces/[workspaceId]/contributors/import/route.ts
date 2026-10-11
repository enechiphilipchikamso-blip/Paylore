import { NextResponse } from "next/server";
import {
  getWorkspaceForUser,
  getWorkspaceSubscription,
  listWorkspaceContributors
} from "@paylore/database";
import { clearSessionCookie, getSessionState } from "../../../../../../server/session";
import { assertSameOrigin, RequestSecurityError } from "../../../../../../server/security";
import { getDatabase } from "../../../../../../server/db";
import { previewContributorFile } from "../../../../../../server/contributors-parser";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: RouteContext) {
  try {
    assertSameOrigin(request);
    const { workspaceId } = await params;
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

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file_required" }, { status: 400 });
    }
    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json({ error: "file_too_large" }, { status: 413 });
    }
    const existing = await listWorkspaceContributors(db, workspaceId);
    const result = await previewContributorFile(
      file.name,
      Buffer.from(await file.arrayBuffer()),
      new Set(existing.map((contributor) => contributor.identityWalletAddress))
    );

    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return NextResponse.json({ error: "request_not_allowed" }, { status: 403 });
    }
    if (error instanceof Error && /file|CSV|XLSX|column|worksheet|quoted/i.test(error.message)) {
      return NextResponse.json({ error: "file_could_not_be_processed" }, { status: 400 });
    }
    console.error(JSON.stringify({ event: "contributor_import_preview_failed" }));
    return NextResponse.json({ error: "file_could_not_be_processed" }, { status: 500 });
  }
}
