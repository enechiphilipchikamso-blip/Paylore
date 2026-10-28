import { NextResponse } from "next/server";
import { z } from "zod";
import {
  cancelWorkspaceDeletion,
  getWorkspaceDeletionAudit,
  getWorkspaceDeletionBlockers,
  getWorkspaceDeletionState,
  getWorkspaceForUser,
  getWorkspaceSubscription,
  isWorkspaceRetentionEligible,
  permanentlyDeleteEligibleWorkspace,
  requestWorkspaceDeletion
} from "@paylore/database";
import { clearSessionCookie, getSessionState } from "../../../../../server/session";
import { assertSameOrigin, RequestSecurityError } from "../../../../../server/security";
import { getDatabase } from "../../../../../server/db";
import { getWorkspaceGasTankSnapshot } from "../../../../../server/gas-tank";

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("request") }),
  z.object({ action: z.literal("cancel") }),
  z.object({
    action: z.literal("finalize"),
    confirmation: z.literal("DELETE WORKSPACE DATA")
  })
]);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authorize(workspaceId: string) {
  const session = await getSessionState();
  if (session.status !== "authenticated") {
    await clearSessionCookie();
    return {
      response: NextResponse.json(
        { error: "authentication_required" },
        { status: 401 }
      )
    };
  }
  const db = getDatabase();
  const membership = await getWorkspaceForUser(
    db,
    session.session.userId,
    workspaceId,
    { recordActivity: false }
  );
  if (!membership || membership.role !== "organization_admin") {
    return {
      response: NextResponse.json(
        { error: "workspace_access_denied" },
        { status: 403 }
      )
    };
  }
  return { db };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ workspaceId: string }> }
): Promise<Response> {
  const { workspaceId } = await params;
  const access = await authorize(workspaceId);
  if ("response" in access) return access.response!;
  try {
    await getWorkspaceGasTankSnapshot(access.db, workspaceId);
    const [state, audit, blockers, subscription] = await Promise.all([
      getWorkspaceDeletionState(access.db, workspaceId),
      getWorkspaceDeletionAudit(access.db, workspaceId),
      getWorkspaceDeletionBlockers(access.db, workspaceId),
      getWorkspaceSubscription(access.db, workspaceId)
    ]);
    const inactiveDays = state
      ? Math.max(
          0,
          Math.floor(
            (Date.now() - state.lastActivityAt.getTime()) /
              (24 * 60 * 60 * 1000)
          )
        )
      : 0;
    const retentionEligible = isWorkspaceRetentionEligible({
      inactiveDays,
      subscriptionStatus: subscription?.status ?? null,
      gasTankConfigured: blockers.gasTank !== "not_configured",
      reserveConfigured: blockers.reserve,
      outstandingObligations:
        blockers.outstandingPayroll || blockers.confidentialAccounts
    });
    return NextResponse.json(
      {
        state,
        audit,
        blockers,
        retention: {
          inactiveDays,
          retentionEligible,
          paidOrActive:
            subscription?.status === "active" ||
            subscription?.status === "cancel_scheduled"
        }
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    console.error(JSON.stringify({ event: "workspace_retention_read_failed" }));
    return NextResponse.json(
      { error: "workspace_retention_unavailable" },
      { status: 503 }
    );
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> }
): Promise<Response> {
  try {
    assertSameOrigin(request);
    const body = await request.json().catch(() => null);
    const parsed = actionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_deletion_action" },
        { status: 400 }
      );
    }

    const { workspaceId } = await params;
    const access = await authorize(workspaceId);
    if ("response" in access) return access.response!;

    if (parsed.data.action === "request") {
      const result = await requestWorkspaceDeletion(
        access.db,
        workspaceId
      );
      return NextResponse.json(
        { status: "pending", ...result },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    if (parsed.data.action === "cancel") {
      const result = await cancelWorkspaceDeletion(
        access.db,
        workspaceId
      );
      if (!result) {
        return NextResponse.json(
          { error: "deletion_cannot_be_canceled" },
          { status: 409 }
        );
      }
      return NextResponse.json(
        { status: "canceled" },
        { headers: { "Cache-Control": "no-store" } }
      );
    }

    await getWorkspaceGasTankSnapshot(access.db, workspaceId);
    const result = await permanentlyDeleteEligibleWorkspace(access.db, {
      workspaceId
    });
    if (result.status !== "deleted") {
      const status =
        result.status === "waiting_period" ||
        result.status === "request_required" ||
        result.status === "workspace_not_found"
          ? 409
          : 423;
      return NextResponse.json(
        { error: result.status },
        { status }
      );
    }
    return NextResponse.json(
      { status: "deleted" },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return NextResponse.json(
        { error: "request_not_allowed" },
        { status: 403 }
      );
    }
    console.error(JSON.stringify({ event: "workspace_deletion_failed" }));
    return NextResponse.json(
      { error: "workspace_deletion_unavailable" },
      { status: 503 }
    );
  }
}
