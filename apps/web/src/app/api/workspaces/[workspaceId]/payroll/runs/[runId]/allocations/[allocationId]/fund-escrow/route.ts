import { NextResponse } from "next/server";
import { getWorkspaceForUser } from "@paylore/database";
import { clearSessionCookie, getSessionState } from "../../../../../../../../../../server/session";
import { getDatabase } from "../../../../../../../../../../server/db";
import { assertSameOrigin, RequestSecurityError } from "../../../../../../../../../../server/security";
import { logServerFailure, logServerRejection } from "../../../../../../../../../../server/server-error-log";
import {
  fundUnclaimedPayrollClaimEscrow,
  PayrollConfidentialSettlementError
} from "../../../../../../../../../../server/solana/payroll-confidential-settlement";

type RouteContext = {
  params: Promise<{ workspaceId: string; runId: string; allocationId: string }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: RouteContext): Promise<Response> {
  let logContext: Record<string, string> = {};
  try {
    assertSameOrigin(request);
    const { workspaceId, runId, allocationId } = await params;
    logContext = { workspaceId, runId, allocationId };
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

    const result = await fundUnclaimedPayrollClaimEscrow(db, {
      workspaceId, runId, allocationId
    });
    const httpStatus = result.status === "pending" ? 202 : result.status === "workspace_busy" ? 409 : 200;
    if (result.status !== "funded" || result.warning) {
      // Every result that did not end with a clean funded escrow is logged with the step it stopped at,
      // so a stuck funding can be traced without reading the chain by hand. Only public identifiers.
      logServerRejection("payroll_claim_escrow_funding_not_funded", result.status, httpStatus, {
        ...logContext,
        stage: result.stage ?? null,
        warning: result.warning ?? null,
        signature: result.signature ?? null
      });
    }
    return NextResponse.json({
      status: result.status,
      ...(result.signature ? { signature: result.signature } : {}),
      ...(result.warning ? { warning: result.warning } : {}),
      ...(result.stage ? { stage: result.stage } : {})
    }, {
      status: httpStatus,
      headers: { "Cache-Control": "no-store" }
    });
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return NextResponse.json({ error: "request_not_allowed" }, { status: 403 });
    }
    if (error instanceof PayrollConfidentialSettlementError) {
      logServerRejection("payroll_claim_escrow_funding_rejected", error.code, error.statusCode, logContext);
      return NextResponse.json({ error: error.code }, {
        status: error.statusCode,
        headers: { "Cache-Control": "no-store" }
      });
    }
    logServerFailure("payroll_claim_escrow_funding_failed", error, logContext);
    return NextResponse.json({ error: "payroll_claim_escrow_funding_failed" }, {
      status: 503,
      headers: { "Cache-Control": "no-store" }
    });
  }
}
