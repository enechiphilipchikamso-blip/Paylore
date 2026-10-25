import { NextResponse } from "next/server";
import { z } from "zod";
import {
  findWorkspaceContributorByWallet,
  getContributorConfidentialAccount,
  getWorkspaceForUser,
  recordVerifiedPublicCashOutLedger
} from "@paylore/database";
import { getDatabase } from "../../../../../../server/db";
import { clearSessionCookie, getSessionState } from "../../../../../../server/session";
import { assertSameOrigin, RequestSecurityError } from "../../../../../../server/security";
import { loadPayloreConfig } from "../../../../../../server/config";
import {
  CashOutLedgerVerificationError,
  verifyFinalizedCashOutTransaction
} from "../../../../../../server/solana/cash-out-ledger-verification";

const signature = z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{80,90}$/);
const schema = z.object({
  kind: z.enum(["confidential_withdrawal", "circle_usdc_unwrap"]),
  signature,
  amountBaseUnits: z.string().regex(/^[1-9][0-9]{0,19}$/)
}).strict();

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    assertSameOrigin(request);
    if (Number(request.headers.get("content-length") ?? 0) > 2048) {
      return NextResponse.json({ error: "request_too_large" }, { status: 413 });
    }
    const raw = await request.text();
    if (raw.length > 2048) return NextResponse.json({ error: "request_too_large" }, { status: 413 });
    let body: unknown;
    try { body = JSON.parse(raw); }
    catch { return NextResponse.json({ error: "invalid_cash_out_ledger_request" }, { status: 400 }); }
    const parsed = schema.safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "invalid_cash_out_ledger_request" }, { status: 400 });

    const { workspaceId } = await params;
    const session = await getSessionState();
    if (session.status !== "authenticated") {
      await clearSessionCookie();
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }
    const walletAddress = session.session.walletAddress;
    if (!walletAddress) return NextResponse.json({ error: "authenticated_wallet_required" }, { status: 403 });

    const db = getDatabase();
    const workspace = await getWorkspaceForUser(db, session.session.userId, workspaceId);
    if (!workspace || workspace.role !== "contributor") {
      return NextResponse.json({ error: "workspace_access_denied" }, { status: 403 });
    }
    const contributor = await findWorkspaceContributorByWallet(db, workspaceId, walletAddress);
    if (!contributor || contributor.lifecycle === "left") {
      return NextResponse.json({ error: "contributor_record_not_found" }, { status: 404 });
    }
    const account = await getContributorConfidentialAccount(db, workspaceId, contributor.id);
    if (!account || account.status !== "ready" || account.ownerWalletAddress !== walletAddress) {
      return NextResponse.json({ error: "contributor_confidential_account_not_ready" }, { status: 409 });
    }

    const config = loadPayloreConfig();
    const wrappedMint = config.PAYLORE_WRAPPED_USDC_MINT;
    if (!wrappedMint) return NextResponse.json({ error: "confidential_mint_unavailable" }, { status: 503 });
    const kind = parsed.data.kind;
    const circleMint = kind === "circle_usdc_unwrap"
      ? config.PAYLORE_SUBSCRIPTION_USDC_MINT ?? null
      : null;
    let verified: Awaited<ReturnType<typeof verifyFinalizedCashOutTransaction>>;
    try {
      verified = await verifyFinalizedCashOutTransaction({
        kind,
        signature: parsed.data.signature,
        amountBaseUnits: parsed.data.amountBaseUnits,
        walletAddress,
        tokenAccountAddress: account.tokenAccountAddress,
        wrappedMint,
        circleMint,
        tokenWrapProgramId: config.TOKEN_WRAP_PROGRAM_ID
      });
    } catch (error) {
      const errorCode = error instanceof CashOutLedgerVerificationError
        ? error.code : "cash_out_reconciliation_unavailable";
      const outcomeStatus = errorCode === "cash_out_transaction_not_finalized" ||
        errorCode === "cash_out_reconciliation_unavailable" ? "pending" as const : "failed" as const;
      const outcomeType = outcomeStatus === "pending"
        ? "cash_out_reconciliation_pending" : "cash_out_reconciliation_failed";
      const outcome = await recordWorkspaceNonFinancialOutcome(db, {
        workspaceId,
        idempotencyKey: `cash-out-reconciliation:${kind}:${parsed.data.signature}:${outcomeStatus}:${errorCode}`,
        category: "cash_out",
        entryType: outcomeType,
        status: outcomeStatus,
        referenceType: "contributor",
        referenceId: contributor.id,
        transactionSignature: parsed.data.signature,
        metadata: { outcome: outcomeStatus, errorCode }
      }).catch(() => ({ status: "conflict" as const }));
      if (outcome.status === "conflict") {
        return NextResponse.json({ error: "cash_out_reconciliation_ledger_conflict" }, {
          status: 503, headers: { "Cache-Control": "no-store" }
        });
      }
      throw error;
    }
    const recorded = await recordVerifiedPublicCashOutLedger(db, {
      workspaceId,
      contributorId: contributor.id,
      contributorWalletAddress: walletAddress,
      kind,
      signature: parsed.data.signature,
      amountBaseUnits: verified.amountBaseUnits,
      mint: verified.mint,
      sourceTokenAccount: verified.sourceTokenAccount,
      destinationTokenAccount: verified.destinationTokenAccount
    });
    if (recorded.status === "conflict" || recorded.status === "not_found") {
      return NextResponse.json({
        error: recorded.status === "not_found"
          ? "contributor_record_not_found"
          : "cash_out_ledger_conflict"
      }, {
        status: 409,
        headers: { "Cache-Control": "no-store" }
      });
    }
    return NextResponse.json({
      status: recorded.status,
      kind,
      signature: parsed.data.signature
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return NextResponse.json({ error: "request_not_allowed" }, { status: 403 });
    }
    if (error instanceof CashOutLedgerVerificationError) {
      return NextResponse.json({ error: error.code }, {
        status: error.statusCode,
        headers: { "Cache-Control": "no-store" }
      });
    }
    console.error(JSON.stringify({ event: "cash_out_ledger_reconciliation_failed" }));
    return NextResponse.json({ error: "cash_out_ledger_reconciliation_unavailable" }, {
      status: 503,
      headers: { "Cache-Control": "no-store" }
    });
  }
}
