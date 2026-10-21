import { NextResponse } from "next/server";
import { z } from "zod";
import { applyVerifiedSubscriptionPayment, createWorkspaceNotificationForFinanceMembers, getSubscriptionPaymentAttempt, getWorkspaceForUser, recordSubscriptionPaymentAttemptSignature, updateSubscriptionPaymentAttemptStatus } from "@paylore/database";
import { getDatabase } from "../../../../../server/db";
import { assertSameOrigin, RequestSecurityError } from "../../../../../server/security";
import { clearSessionCookie, getSessionState } from "../../../../../server/session";
import { PaymentVerificationError, verifySubscriptionPayment } from "../../../../../server/solana/payment-verification";

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
    if (!attempt.signature) return NextResponse.json({ status: "reconciliation_required" }, { status: 202 });

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
