import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getWorkspaceDeletionState,
  getWorkspaceForUser,
  getWorkspaceSubscription
} from "@paylore/database";
import { clearSessionCookie, getSessionState } from "../../../../../server/session";
import { assertSameOrigin, RequestSecurityError } from "../../../../../server/security";
import { getDatabase } from "../../../../../server/db";
import {
  getWorkspaceGasTankSnapshot,
  initializeWorkspaceGasTank,
  verifyAndRestoreWorkspaceGasTank,
  verifyWorkspaceGasTankFunding
} from "../../../../../server/gas-tank";
import { readSolanaRpc } from "../../../../../server/solana/rpc";

const fundingLamports = z
  .string()
  .regex(/^[1-9]\d{0,19}$/)
  .refine((value) => BigInt(value) < (1n << 64n));
const signatureSchema = z
  .string()
  .regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("initialize") }),
  z.object({ action: z.literal("restore") }),
  z.object({
    action: z.literal("prepare_funding"),
    lamports: fundingLamports
  }),
  z.object({
    action: z.literal("verify_funding"),
    signature: signatureSchema,
    lamports: fundingLamports
  })
]);

const LOW_BALANCE_LAMPORTS = 50_000_000n;
const MAX_REQUEST_BYTES = 2_048;

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
    workspaceId
  );
  if (!membership || membership.role === "contributor") {
    return {
      response: NextResponse.json(
        { error: "workspace_access_denied" },
        { status: 403 }
      )
    };
  }
  return { db, membership, session: session.session };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ workspaceId: string }> }
): Promise<Response> {
  const { workspaceId } = await params;
  const access = await authorize(workspaceId);
  if ("response" in access) return access.response!;
  try {
    const gasTank = await getWorkspaceGasTankSnapshot(
      access.db,
      workspaceId
    );
    return NextResponse.json({
      gasTank: gasTank
        ? {
            address: gasTank.address,
            balanceLamports: gasTank.balanceLamports,
            lowBalance:
              BigInt(gasTank.balanceLamports) < LOW_BALANCE_LAMPORTS,
            lastActivityAt: gasTank.lastActivityAt,
            updatedAt: gasTank.updatedAt
          }
        : null
    });
  } catch {
    console.error(JSON.stringify({ event: "gas_tank_snapshot_failed" }));
    return NextResponse.json(
      { error: "gas_tank_unavailable" },
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
    if (Number(request.headers.get("content-length") ?? 0) > MAX_REQUEST_BYTES) {
      return NextResponse.json({ error: "request_too_large" }, { status: 413 });
    }
    const text = await request.text();
    if (text.length > MAX_REQUEST_BYTES) {
      return NextResponse.json({ error: "request_too_large" }, { status: 413 });
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return NextResponse.json({ error: "invalid_gas_tank_action" }, { status: 400 });
    }
    const parsed = actionSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_gas_tank_action" }, { status: 400 });
    }

    const { workspaceId } = await params;
    const access = await authorize(workspaceId);
    if ("response" in access) return access.response!;
    if (access.membership.role !== "organization_admin") {
      return NextResponse.json({ error: "workspace_access_denied" }, { status: 403 });
    }
    if (
      parsed.data.action === "initialize" ||
      parsed.data.action === "prepare_funding"
    ) {
      const deletionState = await getWorkspaceDeletionState(
        access.db,
        workspaceId
      );
      if (
        deletionState?.deletionScheduledAt &&
        !deletionState.deletionCanceledAt
      ) {
        return NextResponse.json(
          { error: "workspace_deletion_pending" },
          { status: 409 }
        );
      }
    }
    const subscription = await getWorkspaceSubscription(
      access.db,
      workspaceId
    );
    if (
      subscription?.status !== "active" &&
      subscription?.status !== "cancel_scheduled"
    ) {
      return NextResponse.json({ error: "workspace_read_only" }, { status: 409 });
    }

    if (parsed.data.action === "initialize") {
      const result = await initializeWorkspaceGasTank(access.db, workspaceId);
      return NextResponse.json({
        status: "ready",
        address: result.address,
        created: result.created
      });
    }
    if (parsed.data.action === "restore") {
      const result = await verifyAndRestoreWorkspaceGasTank(
        access.db,
        workspaceId
      );
      return NextResponse.json({
        status: "ready",
        address: result.address,
        restoredAt: result.restoredAt
      });
    }
    if (parsed.data.action === "prepare_funding") {
      const gasTank = await getWorkspaceGasTankSnapshot(
        access.db,
        workspaceId
      );
      if (!gasTank) {
        return NextResponse.json({ error: "gas_tank_not_initialized" }, { status: 409 });
      }
      const blockhash = await readSolanaRpc<{
        value: { blockhash: string; lastValidBlockHeight: number };
      }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
      return NextResponse.json({
        payer: access.session.walletAddress,
        destination: gasTank.address,
        lamports: parsed.data.lamports,
        blockhash: blockhash.value.blockhash,
        lastValidBlockHeight: blockhash.value.lastValidBlockHeight
      });
    }

    const verification = await verifyWorkspaceGasTankFunding(access.db, {
      workspaceId,
      payer: access.session.walletAddress,
      signature: parsed.data.signature,
      expectedLamports: parsed.data.lamports
    });
    if (verification.status === "pending") {
      return NextResponse.json(
        { status: "pending", signature: parsed.data.signature },
        { status: 202 }
      );
    }
    if (verification.status === "invalid") {
      return NextResponse.json(
        { error: "funding_transaction_not_eligible" },
        { status: 409 }
      );
    }
    return NextResponse.json({
      status: "finalized",
      duplicate: verification.duplicate,
      signature: parsed.data.signature
    });
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return NextResponse.json({ error: "request_not_allowed" }, { status: 403 });
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
    console.error(JSON.stringify({ event: "gas_tank_action_failed" }));
    return NextResponse.json(
      { error: "gas_tank_operation_failed" },
      { status: 503 }
    );
  }
}
