import { NextResponse } from "next/server";
import {
  cancelPayrollDraft,
  getWorkspaceForUser,
  getWorkspacePayrollRun
} from "@paylore/database";
import { clearSessionCookie, getSessionState } from "../../../../../../../server/session";
import { getDatabase } from "../../../../../../../server/db";
import { assertSameOrigin, RequestSecurityError } from "../../../../../../../server/security";

type RouteContext = {
  params: Promise<{ workspaceId: string; runId: string }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: RouteContext) {
  const { workspaceId, runId } = await params;
  const session = await getSessionState();
  if (session.status !== "authenticated") {
    await clearSessionCookie();
    return NextResponse.json(
      { error: "authentication_required" },
      { status: 401 }
    );
  }
  const db = getDatabase();
  const workspace = await getWorkspaceForUser(
    db,
    session.session.userId,
    workspaceId
  );
  if (!workspace || workspace.role === "contributor") {
    return NextResponse.json(
      { error: "workspace_access_denied" },
      { status: 403 }
    );
  }
  const payrollRun = await getWorkspacePayrollRun(db, workspaceId, runId);
  if (!payrollRun) {
    return NextResponse.json({ error: "payroll_run_not_found" }, { status: 404 });
  }
  return NextResponse.json(payrollRun, {
    headers: { "Cache-Control": "no-store" }
  });
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    assertSameOrigin(request);
    const { workspaceId, runId } = await params;
    const session = await getSessionState();
    if (session.status !== "authenticated") {
      await clearSessionCookie();
      return NextResponse.json(
        { error: "authentication_required" },
        { status: 401 }
      );
    }
    const db = getDatabase();
    const workspace = await getWorkspaceForUser(
      db,
      session.session.userId,
      workspaceId
    );
    if (!workspace || workspace.role !== "organization_admin") {
      return NextResponse.json(
        { error: "workspace_access_denied" },
        { status: 403 }
      );
    }
    const body = await request.json();
    if (body?.action !== "cancel") {
      return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    }
    const result = await cancelPayrollDraft(
      db,
      workspaceId,
      runId
    );
    if (result.status === "not_found") {
      return NextResponse.json(
        { error: "payroll_run_not_found" },
        { status: 404 }
      );
    }
    if (result.status === "commitment_started") {
      return NextResponse.json(
        { error: "payroll_commitment_already_started" },
        { status: 409 }
      );
    }
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" }
    });
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return NextResponse.json({ error: "request_not_allowed" }, { status: 403 });
    }
    console.error(JSON.stringify({ event: "payroll_draft_cancellation_failed" }));
    return NextResponse.json(
      { error: "payroll_draft_cancellation_failed" },
      { status: 503 }
    );
  }
}
