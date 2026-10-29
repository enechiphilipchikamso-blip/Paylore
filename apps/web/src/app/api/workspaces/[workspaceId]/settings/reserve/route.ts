import { NextResponse } from "next/server";
import { z } from "zod";
import type { Database } from "@paylore/database";
import {
  getWorkspaceForUser,
  getWorkspaceReserve,
  getWorkspaceSubscription
} from "@paylore/database";
import { clearSessionCookie, getSessionState } from "../../../../../../server/session";
import { assertSameOrigin, RequestSecurityError } from "../../../../../../server/security";
import { getDatabase } from "../../../../../../server/db";
import {
  initializeWorkspaceReserve,
  verifyAndRestoreWorkspaceReserve
} from "../../../../../../server/reserve";
import {
  getWorkspaceConfidentialReserveSnapshot,
  initializeWorkspaceConfidentialReserveAccount,
  WorkspaceReserveInitializationError
} from "../../../../../../server/solana/workspace-reserve";

const reserveActionSchema = z.object({
  action: z.enum(["initialize", "restore", "initialize_confidential"]).default("initialize"),
  signature: z.string().min(32).max(128).nullable().optional(),
  phase: z.enum(["account_setup", "program_configure"]).nullable().optional()
}).strict();

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type WorkspaceAccess =
  | { status: "denied"; response: NextResponse }
  | { status: "authorized"; db: Database; walletAddress: string };

async function authorized(workspaceId: string): Promise<WorkspaceAccess> {
  const session = await getSessionState();
  if (session.status !== "authenticated") {
    await clearSessionCookie();
    return {
      status: "denied",
      response: NextResponse.json(
        { error: "authentication_required" },
        { status: 401 }
      )
    };
  }
  const db = getDatabase();
  const membership = await getWorkspaceForUser(db, session.session.userId, workspaceId);
  if (!membership || membership.role !== "organization_admin") {
    return {
      status: "denied",
      response: NextResponse.json(
        { error: "workspace_access_denied" },
        { status: 403 }
      )
    };
  }
  return {
    status: "authorized",
    db,
    walletAddress: session.session.walletAddress
  };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const access = await authorized(workspaceId);
  if (access.status === "denied") return access.response;
  try {
    const reserve = await getWorkspaceReserve(access.db, workspaceId);
    const onChainAccount = await getWorkspaceConfidentialReserveSnapshot(
      access.db, workspaceId, access.walletAddress
    );
    return NextResponse.json(
      {
        reserve: reserve
          ? {
              address: reserve.address,
              createdAt: reserve.createdAt,
              updatedAt: reserve.updatedAt
            }
          : null,
        onChainAccount
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof WorkspaceReserveInitializationError) {
      return NextResponse.json({ error: error.code }, {
        status: error.statusCode, headers: { "Cache-Control": "no-store" }
      });
    }
    console.error(JSON.stringify({ event: "workspace_reserve_reconciliation_failed" }));
    return NextResponse.json(
      { error: "reserve_reconciliation_unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> }
): Promise<NextResponse> {
  let attemptedAction: "initialize" | "restore" | "initialize_confidential" = "initialize";
  try {
    assertSameOrigin(request);
    const { workspaceId } = await params;
    const access = await authorized(workspaceId);
    if (access.status === "denied") return access.response;
    const subscription = await getWorkspaceSubscription(access.db, workspaceId);
    if (subscription?.status !== "active" && subscription?.status !== "cancel_scheduled") {
      return NextResponse.json({ error: "workspace_read_only" }, { status: 409 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid_reserve_action" }, { status: 400 });
    }
    const parsed = reserveActionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_reserve_action" }, { status: 400 });
    }
    attemptedAction = parsed.data.action;

    if (parsed.data.action === "initialize_confidential") {
      const result = await initializeWorkspaceConfidentialReserveAccount(
        access.db,
        workspaceId,
        access.walletAddress,
        { signature: parsed.data.signature ?? null, phase: parsed.data.phase ?? null }
      );
      return NextResponse.json(result, {
        status: result.status === "pending" ? 202 : 200,
        headers: { "Cache-Control": "no-store" }
      });
    }

    const reserve = parsed.data.action === "restore"
      ? await verifyAndRestoreWorkspaceReserve(access.db, workspaceId)
      : await initializeWorkspaceReserve(access.db, workspaceId);
    return NextResponse.json({
      status: "key_custody_configured",
      address: reserve.address,
      created: "created" in reserve ? reserve.created : false,
      restoredAt: "restoredAt" in reserve ? reserve.restoredAt : null
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return NextResponse.json({ error: "request_not_allowed" }, { status: 403 });
    }
    if (error instanceof WorkspaceReserveInitializationError) {
      const event = attemptedAction === "initialize_confidential"
        ? "workspace_confidential_reserve_initialization_failed"
        : attemptedAction === "restore"
          ? "workspace_reserve_key_custody_restore_failed"
          : "workspace_reserve_key_custody_configuration_failed";
      console.error(JSON.stringify({
        event,
        code: error.code,
        status: error.statusCode
      }));
      return NextResponse.json({
        error: error.code,
        retryable: error.statusCode === 503
      }, {
        status: error.statusCode,
        headers: { "Cache-Control": "no-store" }
      });
    }
    if (
      error instanceof Error &&
      error.message === "WORKSPACE_DELETION_PENDING"
    ) {
      return NextResponse.json(
        { error: "workspace_deletion_pending" },
        { status: 409 }
      );
    }
    const event = attemptedAction === "initialize_confidential"
      ? "workspace_confidential_reserve_initialization_failed"
      : attemptedAction === "restore"
        ? "workspace_reserve_key_custody_restore_failed"
        : "workspace_reserve_key_custody_configuration_failed";
    console.error(JSON.stringify({ event, code: "unexpected_operation_failure" }));
    return NextResponse.json(
      {
        error: attemptedAction === "initialize_confidential"
          ? "reserve_operation_unavailable"
          : "reserve_key_custody_unavailable",
        retryable: true
      },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
