import { NextResponse } from "next/server";
import { z } from "zod";
import { applyVerifiedSubscriptionPayment, createWorkspaceNotificationForFinanceMembers, getSubscriptionPaymentAttempt, getWorkspaceForUser, recordSubscriptionPaymentAttemptSignature, updateSubscriptionPaymentAttemptStatus } from "@paylore/database";
import { getDatabase } from "../../../../../server/db";
import { assertSameOrigin, RequestSecurityError } from "../../../../../server/security";
import { clearSessionCookie, getSessionState } from "../../../../../server/session";
import { PaymentVerificationError, verifySubscriptionPayment } from "../../../../../server/solana/payment-verification";
import { readSolanaRpc } from "../../../../../server/solana/rpc";
import { assessAmbiguousPaymentAttempt, PAYMENT_ATTEMPT_SIGNATURE_SCAN_LIMIT } from "../../../../../server/solana/payment-attempt-reconciliation";

const schema = z.object({ attemptId: z.string().uuid(), signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/).optional() });
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ workspaceId: string }> }) {
  try {
    assertSameOrigin(request);
    const session = await getSessionState();
    if (session.status !== "authenticated") {
      await clearSessionCookie();
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }
    const { workspaceId } = await params;
    const db = getDatabase();
    const membership = await getWorkspaceForUser(db, session.session.userId, workspaceId);
    if (!membership || membership.role !== "organization_admin") return NextResponse.json({ error: "workspace_access_denied" }, { status: 403 });
    const parsed = schema.safeParse(await request.json());
    if (!parsed.success) return NextResponse.json({ error: "invalid_payment_attempt" }, { status: 400 });
    let attempt = await getSubscriptionPaymentAttempt(db, parsed.data.attemptId);
    if (!attempt || attempt.workspaceId !== workspaceId || attempt.userId !== session.session.userId || attempt.payerWalletAddress !== session.session.walletAddress) return NextResponse.json({ error: "payment_attempt_not_found" }, { status: 404 });
    if (parsed.data.signature) attempt = await recordSubscriptionPaymentAttemptSignature(db, { attemptId: attempt.id, signature: parsed.data.signature });
    if (attempt.status === "confirmed") return NextResponse.json({ status: "active" });
    if (!attempt.signature) {
      const [blockHeight, recentSignatures] = await Promise.all([
        readSolanaRpc<number>("getBlockHeight", [{ commitment: "finalized" }]),
        readSolanaRpc<Array<{ signature: string; slot: number; err: unknown; blockTime: number | null }>>(
          "getSignaturesForAddress",
          [attempt.payerWalletAddress, { commitment: "finalized", limit: PAYMENT_ATTEMPT_SIGNATURE_SCAN_LIMIT }]
        )
      ]);
      // Signature history does not include memo contents; inspect each finalized
      // transaction rather than treating the RPC signature record as if it did.
      const signatures = await Promise.all(recentSignatures.map(async (entry) => {
        const transaction = await readSolanaRpc<{
          transaction?: { message?: { instructions?: Array<{ program?: string; parsed?: unknown }> } };
          meta?: { err?: unknown } | null;
        } | null>("getTransaction", [entry.signature, {
          commitment: "finalized", encoding: "jsonParsed", maxSupportedTransactionVersion: 0
        }]).catch(() => null);
        const instructions = transaction?.transaction?.message?.instructions ?? [];
        const memoInstruction = instructions.find((instruction) =>
          instruction.program === "spl-memo" && typeof instruction.parsed === "string"
        );
        return {
          ...entry,
          err: transaction?.meta?.err ?? entry.err,
          memo: typeof memoInstruction?.parsed === "string" ? memoInstruction.parsed : null
        };
      }));
      const decision = assessAmbiguousPaymentAttempt({
        currentFinalizedBlockHeight: blockHeight,
        lastValidBlockHeight: attempt.lastValidBlockHeight,
        attemptCreatedAt: attempt.createdAt,
        expectedMemo: attempt.memo,
        signatures
      });
      if (decision.kind === "submitted") {
        if (decision.failedOnChain) {
          await updateSubscriptionPaymentAttemptStatus(db, { attemptId: attempt.id, status: "failed", signature: null });
          return NextResponse.json({ status: "safe_to_retry" });
        }
        attempt = await recordSubscriptionPaymentAttemptSignature(db, { attemptId: attempt.id, signature: decision.signature });
      } else if (decision.kind === "safe_to_retry") {
        await updateSubscriptionPaymentAttemptStatus(db, { attemptId: attempt.id, status: "expired", signature: null });
        return NextResponse.json({ status: "safe_to_retry" });
      } else {
        return NextResponse.json({ status: "reconciliation_required" }, { status: 202 });
      }
    }

    try {
      const verified = await verifySubscriptionPayment(attempt.signature, session.session.walletAddress);
      if (verified.recipient !== attempt.recipient || verified.mint !== attempt.mint || verified.amountBaseUnits !== attempt.amountBaseUnits) {
        await updateSubscriptionPaymentAttemptStatus(db, { attemptId: attempt.id, status: "failed", signature: attempt.signature });
        return NextResponse.json({ error: "payment_attempt_mismatch" }, { status: 422 });
      }
      await applyVerifiedSubscriptionPayment(db, { workspaceId, userId: session.session.userId, ...verified });
      await updateSubscriptionPaymentAttemptStatus(db, { attemptId: attempt.id, status: "confirmed", signature: attempt.signature });
      await createWorkspaceNotificationForFinanceMembers(db, {
        workspaceId, eventKey: `subscription-payment:${attempt.signature}`, category: "workspace_billing",
        title: "Subscription payment confirmed",
        body: "A verified USDC payment activated or renewed this workspace subscription.",
        destination: `/workspace/${workspaceId}/billing`
      });
      return NextResponse.json({ status: "active" });
    } catch (error) {
      if (error instanceof PaymentVerificationError && error.reason === "not_found") return NextResponse.json({ status: "reconciliation_required" }, { status: 202 });
      if (error instanceof PaymentVerificationError) return NextResponse.json({ error: "payment_could_not_be_verified" }, { status: 422 });
      throw error;
    }
  } catch (error) {
    if (error instanceof RequestSecurityError) return NextResponse.json({ error: "request_not_allowed" }, { status: 403 });
    console.error(JSON.stringify({ event: "subscription_payment_attempt_reconciliation_failed" }));
    return NextResponse.json({ error: "payment_attempt_reconciliation_failed" }, { status: 500 });
  }
}
