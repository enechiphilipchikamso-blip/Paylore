import { NextResponse } from "next/server";
import { z } from "zod";
import { getWorkspaceForUser, getWorkspaceSubscription } from "@paylore/database";
import { clearSessionCookie, getSessionState } from "../../../../../../../server/session";
import { assertSameOrigin, RequestSecurityError } from "../../../../../../../server/security";
import { getDatabase } from "../../../../../../../server/db";
import {
  prepareReserveWrapFunding, ReserveWrapFundingError, verifyFinalizedReserveWrapFunding
} from "../../../../../../../server/solana/reserve-wrap-funding";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  action: z.enum(["prepare", "verify"]),
  amountBaseUnits: z.string().regex(/^[1-9][0-9]{0,19}$/),
  signature: z.string().min(32).max(128).optional()
}).strict().superRefine((value, context) => {
  if (value.action === "verify" && !value.signature) {
    context.addIssue({ code: "custom", path: ["signature"], message: "A transaction signature is required." });
  }
});

export async function POST(request: Request, { params }: { params: Promise<{ workspaceId: string }> }): Promise<NextResponse> {
  let action: "prepare" | "verify" | "unknown" = "unknown";
  try {
    assertSameOrigin(request);
    const { workspaceId } = await params;
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
    const subscription = await getWorkspaceSubscription(db, workspaceId);
    if (subscription?.status !== "active" && subscription?.status !== "cancel_scheduled") {
      return NextResponse.json({ error: "workspace_read_only" }, { status: 409 });
    }
    let rawBody: unknown;
    try { rawBody = await request.json(); }
    catch { return NextResponse.json({ error: "invalid_reserve_wrap_request" }, { status: 400 }); }
    const parsed = requestSchema.safeParse(rawBody);
    if (!parsed.success) return NextResponse.json({ error: "invalid_reserve_wrap_request" }, { status: 400 });
    action = parsed.data.action;
    const result = action === "prepare"
      ? await prepareReserveWrapFunding({
          db, workspaceId, walletAddress: session.session.walletAddress,
          amountBaseUnits: parsed.data.amountBaseUnits
        })
      : await verifyFinalizedReserveWrapFunding({
          db, workspaceId, walletAddress: session.session.walletAddress,
          amountBaseUnits: parsed.data.amountBaseUnits, signature: parsed.data.signature!
        });
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" }
    });
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return NextResponse.json({ error: "request_not_allowed" }, { status: 403 });
    }
    if (error instanceof ReserveWrapFundingError) {
      console.error(JSON.stringify({
        event: "workspace_reserve_wrap_funding_reconciliation_failed",
        action, code: error.code, status: error.statusCode
      }));
      return NextResponse.json({
        error: error.code, retryable: error.statusCode === 202 || error.statusCode >= 500
      }, { status: error.statusCode, headers: { "Cache-Control": "no-store" } });
    }
    console.error(JSON.stringify({
      event: "workspace_reserve_wrap_funding_failed",
      action, code: "unexpected_operation_failure"
    }));
    return NextResponse.json({ error: "reserve_wrap_funding_unavailable", retryable: true },
      { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
