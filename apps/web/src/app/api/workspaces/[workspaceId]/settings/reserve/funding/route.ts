import { NextResponse } from "next/server";
import {
  getActiveWorkspaceReserveFundingOperation,
  getWorkspaceForUser,
  getWorkspaceSubscription
} from "@paylore/database";
import { z } from "zod";
import { clearSessionCookie, getSessionState } from "../../../../../../../server/session";
import { assertSameOrigin, RequestSecurityError } from "../../../../../../../server/security";
import { getDatabase } from "../../../../../../../server/db";
import {
  markReserveWrapFundingFailed,
  markReserveWrapFundingVerified,
  prepareReserveWrapFunding,
  recordPendingReserveWrapFunding,
  ReserveWrapFundingError,
  verifyFinalizedReserveWrapFunding
} from "../../../../../../../server/solana/reserve-wrap-funding";
import {
  completeWorkspaceReserveConfidentialFunding,
  WorkspaceReserveInitializationError
} from "../../../../../../../server/solana/workspace-reserve";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const requestSchema = z.object({
  action: z.enum(["prepare", "verify"]),
  amountBaseUnits: z.string().regex(/^[1-9][0-9]{0,19}$/),
  signature: z.string().min(32).max(128).optional()
}).strict().superRefine((value, context) => {
  if (value.action === "verify" && !value.signature) {
    context.addIssue({
      code: "custom",
      path: ["signature"],
      message: "A transaction signature is required."
    });
  }
});

async function authenticatedReserveAdmin(
  workspaceId: string
): Promise<
  | { ok: true; db: ReturnType<typeof getDatabase>; walletAddress: string }
  | { ok: false; response: NextResponse }
> {
  const session = await getSessionState();
  if (session.status !== "authenticated") {
    await clearSessionCookie();
    return { ok: false, response: NextResponse.json({ error: "authentication_required" }, { status: 401 }) };
  }
  const db = getDatabase();
  const membership = await getWorkspaceForUser(db, session.session.userId, workspaceId);
  if (!membership || membership.role !== "organization_admin") {
    return { ok: false, response: NextResponse.json({ error: "workspace_access_denied" }, { status: 403 }) };
  }
  const subscription = await getWorkspaceSubscription(db, workspaceId);
  if (subscription?.status !== "active" && subscription?.status !== "cancel_scheduled") {
    return { ok: false, response: NextResponse.json({ error: "workspace_read_only" }, { status: 409 }) };
  }
  return { ok: true, db, walletAddress: session.session.walletAddress };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> }
): Promise<NextResponse> {
  try {
    const { workspaceId } = await params;
    const access = await authenticatedReserveAdmin(workspaceId);
    if (!access.ok) return access.response;
    const operation = await getActiveWorkspaceReserveFundingOperation(access.db, workspaceId);
    if (!operation) {
      return NextResponse.json({ status: "idle" }, {
        headers: { "Cache-Control": "no-store" }
      });
    }
    const data = operation.operationData !== null &&
      typeof operation.operationData === "object" &&
      !Array.isArray(operation.operationData)
      ? operation.operationData as Record<string, unknown>
      : {};
    if (data.walletAddress !== access.walletAddress) {
      return NextResponse.json({
        status: "another_admin_pending",
        message: "A Reserve funding operation is already in progress. Ask the administrator who started it to continue that same transaction."
      }, { status: 409, headers: { "Cache-Control": "no-store" } });
    }
    const wrapSignature = typeof operation.transactionSignature === "string"
      ? operation.transactionSignature
      : typeof data.wrapSignature === "string" ? data.wrapSignature : null;
    const amountBaseUnits = typeof data.amountBaseUnits === "string" ? data.amountBaseUnits : null;
    if (!wrapSignature || !amountBaseUnits || !/^[1-9][0-9]*$/.test(amountBaseUnits)) {
      return NextResponse.json({ error: "reserve_confidential_funding_operation_unavailable" }, {
        status: 503,
        headers: { "Cache-Control": "no-store" }
      });
    }
    const stage = typeof data.stage === "string" ? data.stage : "wrap_verified";
    const phase = stage === "wrap_pending"
      ? "wrap_pending"
      : stage === "wrap_verified"
        ? "wrap_verified"
        : stage.startsWith("preapply")
          ? "preapply"
          : stage.startsWith("deposit")
            ? "deposit"
            : "apply";
    return NextResponse.json({
      status: "pending",
      wrapSignature,
      amountBaseUnits,
      phase,
      stage,
      depositSignature: typeof data.depositSignature === "string" ? data.depositSignature : undefined,
      applySignature: typeof data.applySignature === "string" ? data.applySignature : undefined
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error(JSON.stringify({
      event: "workspace_reserve_confidential_funding_status_failed",
      code: "operation_status_unavailable"
    }));
    return NextResponse.json({ error: "reserve_confidential_funding_status_unavailable" }, {
      status: 503,
      headers: { "Cache-Control": "no-store" }
    });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> }
): Promise<NextResponse> {
  let action: "prepare" | "verify" | "unknown" = "unknown";
  let pendingWrapOperation: {
    db: ReturnType<typeof getDatabase>;
    workspaceId: string;
    operationId: string;
    signature: string;
  } | null = null;
  try {
    assertSameOrigin(request);
    const { workspaceId } = await params;
    const access = await authenticatedReserveAdmin(workspaceId);
    if (!access.ok) return access.response;

    let rawBody: unknown;
    try {
      rawBody = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid_reserve_wrap_request" }, { status: 400 });
    }
    const parsed = requestSchema.safeParse(rawBody);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_reserve_wrap_request" }, { status: 400 });
    }
    action = parsed.data.action;

    if (action === "prepare") {
      const prepared = await prepareReserveWrapFunding({
        db: access.db,
        workspaceId,
        walletAddress: access.walletAddress,
        amountBaseUnits: parsed.data.amountBaseUnits
      });
      return NextResponse.json(prepared, { headers: { "Cache-Control": "no-store" } });
    }

    const signature = parsed.data.signature!;
    const recorded = await recordPendingReserveWrapFunding({
      db: access.db,
      workspaceId,
      walletAddress: access.walletAddress,
      amountBaseUnits: parsed.data.amountBaseUnits,
      signature
    });
    pendingWrapOperation = {
      db: access.db,
      workspaceId,
      operationId: recorded.operationId,
      signature
    };
    const verification = await verifyFinalizedReserveWrapFunding({
      db: access.db,
      workspaceId,
      walletAddress: access.walletAddress,
      amountBaseUnits: parsed.data.amountBaseUnits,
      signature
    });
    await markReserveWrapFundingVerified({
      db: access.db,
      workspaceId,
      walletAddress: access.walletAddress,
      operationId: recorded.operationId,
      verification
    });
    const result = await completeWorkspaceReserveConfidentialFunding({
      db: access.db,
      workspaceId,
      fallbackAuthorityAddress: access.walletAddress,
      amountBaseUnits: parsed.data.amountBaseUnits,
      wrapSignature: parsed.data.signature!
    });
    return NextResponse.json(result, {
      status: result.status === "pending" ? 202 : 200,
      headers: { "Cache-Control": "no-store" }
    });
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return NextResponse.json({ error: "request_not_allowed" }, { status: 403 });
    }
    if (error instanceof ReserveWrapFundingError) {
      if (error.code === "reserve_wrap_transaction_failed" && pendingWrapOperation) {
        try {
          await markReserveWrapFundingFailed(pendingWrapOperation);
        } catch {
          console.error(JSON.stringify({
            event: "workspace_reserve_wrap_failure_reconciliation_failed",
            code: "failed_wrap_operation_not_reconciled"
          }));
          return NextResponse.json({
            error: "reserve_wrap_failure_reconciliation_unavailable",
            retryable: true
          }, { status: 503, headers: { "Cache-Control": "no-store" } });
        }
      }
      console.error(JSON.stringify({
        event: "workspace_reserve_wrap_funding_reconciliation_failed",
        action,
        code: error.code,
        status: error.statusCode
      }));
      const wrapFinalityPending = error.code === "reserve_wrap_transaction_not_finalized" ||
        error.code === "reserve_wrap_transaction_status_unavailable";
      return NextResponse.json({
        ...(wrapFinalityPending
          ? { status: "pending", phase: "wrap_pending", stage: "wrap_pending" }
          : {}),
        error: error.code,
        retryable: error.statusCode === 202 || error.statusCode >= 500
      }, { status: error.statusCode, headers: { "Cache-Control": "no-store" } });
    }
    if (error instanceof WorkspaceReserveInitializationError) {
      console.error(JSON.stringify({
        event: "workspace_reserve_confidential_funding_failed",
        action,
        code: error.code,
        status: error.statusCode
      }));
      return NextResponse.json({
        error: error.code,
        retryable: error.statusCode === 202 || error.statusCode >= 500 ||
          error.code === "reserve_confidential_funding_in_progress"
      }, { status: error.statusCode, headers: { "Cache-Control": "no-store" } });
    }
    console.error(JSON.stringify({
      event: "workspace_reserve_wrap_funding_failed",
      action,
      code: "unexpected_operation_failure"
    }));
    return NextResponse.json({ error: "reserve_wrap_funding_unavailable", retryable: true }, {
      status: 503,
      headers: { "Cache-Control": "no-store" }
    });
  }
}
