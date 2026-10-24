import { NextResponse } from "next/server";
import { z } from "zod";
import { getWorkspaceForUser } from "@paylore/database";
import { clearSessionCookie, getSessionState } from "../../../../../../../../../../server/session";
import { getDatabase } from "../../../../../../../../../../server/db";
import { assertSameOrigin, RequestSecurityError } from "../../../../../../../../../../server/security";
import {
  PayrollConfidentialRecoveryError,
  recoverPayrollAllocation
} from "../../../../../../../../../../server/solana/payroll-confidential-recovery";

type RouteContext = {
  params: Promise<{
    workspaceId: string;
    runId: string;
    allocationId: string;
  }>;
};

const recoverySchema = z.object({
  signature: z.string().min(32).max(128).nullable().optional(),
  phase: z.enum(["proof_setup", "reserve_balance_apply", "recovery"]).nullable().optional(),
  reason: z.enum([
    "incorrect_allocation",
    "contributor_left_before_claim",
    "payroll_correction",
    "other"
  ]),
  note: z.string().trim().max(500).nullable().optional()
}).strict();

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: RouteContext) {
  try {
    assertSameOrigin(request);
    const { workspaceId, runId, allocationId } = await params;
    const session = await getSessionState();
    if (session.status !== "authenticated") {
      await clearSessionCookie();
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }

    const db = getDatabase();
    const workspace = await getWorkspaceForUser(db, session.session.userId, workspaceId);
    if (!workspace || workspace.role !== "organization_admin") {
      return NextResponse.json({ error: "workspace_access_denied" }, { status: 403 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid_recovery_request" }, { status: 400 });
    }
    const parsed = recoverySchema.safeParse(body);
    if (!parsed.success || (parsed.data.reason === "other" && !parsed.data.note?.trim())) {
      return NextResponse.json({ error: "invalid_recovery_request" }, { status: 400 });
    }

    const result = await recoverPayrollAllocation(db, {
      workspaceId,
      runId,
      allocationId,
      actorUserId: session.session.userId,
      reason: parsed.data.reason,
      note: parsed.data.reason === "other" ? parsed.data.note!.trim() : null,
      signature: parsed.data.signature ?? null,
      phase: parsed.data.phase ?? null
    });

    const bodyForResult = {
      status: result.status,
      signature: result.signature ?? null,
      phase: result.phase ?? null,
      valueTransferred: result.status === "recovered" || result.status === "already_reconciled",
      ...(result.status === "pending" ? {
        message: "Recovery is being reconciled. Do not submit a second recovery."
      } : {}),
      ...(result.status === "retry_ready" ? {
        message: "No recovery transfer was finalized. Review the status before retrying."
      } : {}),
      ...(result.warning ? { warning: result.warning } : {})
    };
    const statusCode = result.status === "pending" ? 202 :
      result.status === "workspace_busy" ? 409 : 200;
    return NextResponse.json(bodyForResult, {
      status: statusCode,
      headers: { "Cache-Control": "no-store" }
    });
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return NextResponse.json({ error: "request_not_allowed" }, { status: 403 });
    }
    if (error instanceof PayrollConfidentialRecoveryError) {
      return NextResponse.json({
        error: error.code,
        retryable: error.statusCode === 503
      }, {
        status: error.statusCode,
        headers: { "Cache-Control": "no-store" }
      });
    }
    console.error(JSON.stringify({ event: "payroll_recovery_submission_failed" }));
    return NextResponse.json(
      { error: "payroll_recovery_submission_failed" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
