import { NextResponse } from "next/server";
import { findWorkspaceContributorByWallet, getWorkspaceForUser, getWorkspacePayrollRun } from "@paylore/database";
import { getDatabase } from "../../../../../../../../../../server/db";
import { clearSessionCookie, getSessionState } from "../../../../../../../../../../server/session";
import { assertSameOrigin, RequestSecurityError } from "../../../../../../../../../../server/security";
import { PayrollConfidentialSettlementError, settleContributorPayrollAllocation } from "../../../../../../../../../../server/solana/payroll-confidential-settlement";

type RouteContext = { params: Promise<{ workspaceId: string; runId: string; allocationId: string }> };
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
    const wallet = session.session.walletAddress;
    if (!wallet) return NextResponse.json({ error: "authenticated_wallet_required" }, { status: 403 });
    const db = getDatabase();
    const workspace = await getWorkspaceForUser(db, session.session.userId, workspaceId);
    if (!workspace || workspace.role !== "contributor") return NextResponse.json({ error: "workspace_access_denied" }, { status: 403 });
    const contributor = await findWorkspaceContributorByWallet(db, workspaceId, wallet);
    if (!contributor || contributor.lifecycle === "left") return NextResponse.json({ error: "contributor_record_not_found" }, { status: 404 });
    const payroll = await getWorkspacePayrollRun(db, workspaceId, runId);
    const allocation = payroll?.allocations.find((item) => item.id === allocationId);
    if (!allocation || allocation.contributorId !== contributor.id || allocation.contributorWalletAddress !== wallet) {
      return NextResponse.json({ error: "payroll_allocation_not_found" }, { status: 404 });
    }
    const result = await settleContributorPayrollAllocation(db, {
      workspaceId, runId, allocationId, contributorId: contributor.id,
      contributorAddress: wallet, contributorUserId: session.session.userId
    });
    const headers: Record<string, string> = { "Cache-Control": "no-store" };
    if (result.proofDurationMs !== undefined) headers["Server-Timing"] = "confidential-proof;dur=" + result.proofDurationMs.toFixed(2);
    return NextResponse.json({
      status: result.status,
      ...(result.signature ? { signature: result.signature } : {}),
      ...(result.amountBaseUnits ? { amountBaseUnits: result.amountBaseUnits } : {}),
      ...(result.warning ? { warning: result.warning } : {})
    }, { headers });
  } catch (error) {
    if (error instanceof RequestSecurityError) return NextResponse.json({ error: "request_not_allowed" }, { status: 403 });
    if (error instanceof PayrollConfidentialSettlementError) {
      return NextResponse.json({ error: error.code }, { status: error.statusCode, headers: { "Cache-Control": "no-store" } });
    }
    console.error(JSON.stringify({ event: "payroll_confidential_settlement_failed" }));
    return NextResponse.json({ error: "payroll_confidential_settlement_failed" }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
