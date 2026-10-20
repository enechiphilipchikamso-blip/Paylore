import { NextResponse } from "next/server";
import { getWorkspaceForUser } from "@paylore/database";
import { clearSessionCookie, getSessionState } from "../../../../../../../../../../server/session";
import { getDatabase } from "../../../../../../../../../../server/db";
import { assertSameOrigin, RequestSecurityError } from "../../../../../../../../../../server/security";

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
      return NextResponse.json(
        { error: "authentication_required" },
        { status: 401 }
      );
    }
    const workspace = await getWorkspaceForUser(
      getDatabase(),
      session.session.userId,
      workspaceId
    );
    if (!workspace || workspace.role !== "organization_admin") {
      return NextResponse.json(
        { error: "workspace_access_denied" },
        { status: 403 }
      );
    }
    return NextResponse.json(
      { error: "payroll_financial_recovery_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return NextResponse.json(
        { error: "request_not_allowed" },
        { status: 403 }
      );
    }
    console.error(
      JSON.stringify({ event: "payroll_recovery_submission_failed" })
    );
    return NextResponse.json(
      { error: "payroll_recovery_submission_failed" },
      { status: 503 }
    );
  }
}
