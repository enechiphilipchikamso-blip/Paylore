import { NextResponse } from "next/server";
import { z } from "zod";
import { getPayrollClaimEscrow, getWorkspaceForUser } from "@paylore/database";
import { clearSessionCookie, getSessionState } from "../../../../../../../../../../server/session";
import { getDatabase } from "../../../../../../../../../../server/db";
import { assertSameOrigin, RequestSecurityError } from "../../../../../../../../../../server/security";
import {
  PayrollConfidentialRecoveryError,
  recoverPayrollAllocation
} from "../../../../../../../../../../server/solana/payroll-confidential-recovery";

type RouteContext = {
  params: Promise<{ workspaceId: string; runId: string; allocationId: string }>;
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

async function authorize(workspaceId: string) {
  const session = await getSessionState();
  if (session.status !== "authenticated") {
    await clearSessionCookie();
    return {
      response: NextResponse.json({ error: "authentication_required" }, { status: 401 })
    } as const;
  }
  const db = getDatabase();
  const membership = await getWorkspaceForUser(db, session.session.userId, workspaceId);
  if (!membership || membership.role !== "organization_admin") {
    return {
      response: NextResponse.json({ error: "workspace_access_denied" }, { status: 403 })
    } as const;
  }
  return { db, session: session.session } as const;
}

export async function GET(_request: Request, { params }: RouteContext) {
  try {
    const { workspaceId, runId, allocationId } = await params;
    const access = await authorize(workspaceId);
    if ("response" in access) return access.response;

    const escrow = await getPayrollClaimEscrow(access.db, workspaceId, allocationId);
    if (!escrow || escrow.payrollRunId !== runId) {
      return NextResponse.json({ status: "not_available" }, {
        headers: { "Cache-Control": "no-store" }
      });
    }
    const status = escrow.status;
    return NextResponse.json({
      status,
      reason: status === "recovery_pending" ? escrow.recoveryReason : null,
      note: status === "recovery_pending" ? escrow.recoveryReasonNote : null,
      recoverySignature: status === "recovery_pending" ? escrow.recoverySignature : null,
      recoveryApplySignature: status === "recovery_pending" ? escrow.recoveryApplySignature : null,
      proofSetupSignature: status === "recovery_pending"
        ? escrow.recoveryContextSignatures.at(-1) ?? null
        : null
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "payroll_recovery_status_unavailable" }, {
      status: 503, headers: { "Cache-Control": "no-store" }
    });
  }
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    assertSameOrigin(request);
    const { workspaceId, runId, allocationId } = await params;
    const access = await authorize(workspaceId);
    if ("response" in access) return access.response;

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

    const result = await recoverPayrollAllocation(access.db, {
      workspaceId,
      runId,
      allocationId,
      actorUserId: access.session.userId,
      reason: parsed.data.reason,
      note: parsed.data.reason === "other" ? parsed.data.note!.trim() : null,
      signature: parsed.data.signature ?? null,
      phase: parsed.data.phase ?? null
    });
    const valueTransferred = result.status === "recovered" || result.status === "already_reconciled";
    const responseBody = {
      status: result.status,
      signature: result.signature ?? null,
      phase: result.phase ?? null,
      valueTransferred,
      ...(result.status === "pending"
        ? { message: "Recovery is being reconciled. Do not submit a second recovery." }
        : {}),
      ...(result.status === "retry_ready"
        ? { message: "No recovery transfer was finalized. Review the status before retrying." }
        : {}),
      ...(result.warning ? { warning: result.warning } : {})
    };
    return NextResponse.json(responseBody, {
      status: result.status === "pending" ? 202 : result.status === "workspace_busy" ? 409 : 200,
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
