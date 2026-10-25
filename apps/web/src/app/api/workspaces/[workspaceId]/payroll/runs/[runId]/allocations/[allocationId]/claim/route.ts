import { NextResponse } from "next/server";
import { findWorkspaceContributorByWallet, getWorkspaceForUser, getWorkspacePayrollRun, recordWorkspaceNonFinancialOutcome } from "@paylore/database";
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
    let result: Awaited<ReturnType<typeof settleContributorPayrollAllocation>>;
    try {
      result = await settleContributorPayrollAllocation(db, {
        workspaceId, runId, allocationId, contributorId: contributor.id,
        contributorAddress: wallet, contributorUserId: session.session.userId
      });
    } catch (error) {
      const errorCode = error instanceof PayrollConfidentialSettlementError
        ? error.code : "settlement_unavailable";
      const outcome = await recordWorkspaceNonFinancialOutcome(db, {
        workspaceId,
        idempotencyKey: `payroll-settlement-failure:${allocationId}:${errorCode}`,
        category: "payroll",
        entryType: "claim_settlement_failed",
        status: "failed",
        referenceType: "payroll_allocation",
        referenceId: allocationId,
        metadata: { runId, outcome: "failed", errorCode },
      }).catch(() => ({ status: "conflict" as const }));
      if (outcome.status === "conflict") {
        return NextResponse.json({ error: "payroll_settlement_failure_ledger_conflict" }, {
          status: 503, headers: { "Cache-Control": "no-store" }
        });
      }
      throw error;
    }
    if (result.status !== "claimed" && result.status !== "already_settled") {
      const ledgerStatus = result.status === "pending" || result.status === "workspace_busy"
        ? "pending" as const : "failed" as const;
      const outcome = await recordWorkspaceNonFinancialOutcome(db, {
        workspaceId,
        idempotencyKey: `payroll-settlement-outcome:${allocationId}:${result.status}:${result.signature ?? "unsubmitted"}`,
        category: "payroll",
        entryType: `claim_settlement_${result.status}`,
        status: ledgerStatus,
        referenceType: "payroll_allocation",
        referenceId: allocationId,
        transactionSignature: result.signature ?? null,
        metadata: {
          runId,
          outcome: result.status,
          ...(result.warning ? { warning: result.warning } : {})
        }
      }).catch(() => ({ status: "conflict" as const }));
      if (outcome.status === "conflict") {
        return NextResponse.json({ error: "payroll_settlement_outcome_ledger_conflict" }, {
          status: 503, headers: { "Cache-Control": "no-store" }
        });
      }
    }
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
