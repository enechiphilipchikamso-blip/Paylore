import { NextResponse } from "next/server";
import { getWorkspaceForUser } from "@paylore/database";
import { clearSessionCookie, getSessionState } from "../../../../../../../../../../server/session";
import { getDatabase } from "../../../../../../../../../../server/db";
import { assertSameOrigin, RequestSecurityError } from "../../../../../../../../../../server/security";
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
  try {
    assertSameOrigin(request);
    const { workspaceId, runId, allocationId } = await params;
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
    return NextResponse.json({
      status: result.status,
      ...(result.signature ? { signature: result.signature } : {}),
      ...(result.warning ? { warning: result.warning } : {})
    }, {
      status: result.status === "pending" ? 202 : result.status === "workspace_busy" ? 409 : 200,
      headers: { "Cache-Control": "no-store" }
    });
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return NextResponse.json({ error: "request_not_allowed" }, { status: 403 });
    }
    if (error instanceof PayrollConfidentialSettlementError) {
      return NextResponse.json({ error: error.code }, {
        status: error.statusCode,
        headers: { "Cache-Control": "no-store" }
      });
    }
    console.error(JSON.stringify({ event: "payroll_claim_escrow_funding_failed" }));
    return NextResponse.json({ error: "payroll_claim_escrow_funding_failed" }, {
      status: 503,
      headers: { "Cache-Control": "no-store" }
    });
  }
}
