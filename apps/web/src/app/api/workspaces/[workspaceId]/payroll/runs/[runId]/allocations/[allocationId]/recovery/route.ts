import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getWorkspaceForUser,
  getWorkspacePayrollRun,
  recordPayrollRecovery
} from "@paylore/database";
import { clearSessionCookie, getSessionState } from "../../../../../../../../../../server/session";
import { getDatabase } from "../../../../../../../../../../server/db";
import { assertSameOrigin, RequestSecurityError } from "../../../../../../../../../../server/security";
import { verifyPayrollRecoveryTransaction } from "../../../../../../../../../../server/solana/payroll-program-verification";

type RouteContext = {
  params: Promise<{
    workspaceId: string;
    runId: string;
    allocationId: string;
  }>;
};

const recoverySchema = z.object({
  signature: z.string().min(32).max(128),
  reason: z.enum([
    "incorrect_allocation",
    "contributor_left_before_claim",
    "payroll_correction",
    "other"
  ]),
  note: z.string().trim().max(500).nullable().optional()
}).strict();

function reasonCommitment(reason: string, note: string | null): string {
  return createHash("sha256")
    .update(`paylore:recovery:v1:${JSON.stringify({ reason, note })}`)
    .digest("hex");
}

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

    const db = getDatabase();
    const workspace = await getWorkspaceForUser(db, session.session.userId, workspaceId);
    if (!workspace || workspace.role !== "organization_admin") {
      return NextResponse.json({ error: "workspace_access_denied" }, { status: 403 });
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid_recovery_request" }, { status: 400 });
    }
    const parsed = recoverySchema.safeParse(body);
    if (!parsed.success || (parsed.data.reason === "other" && !parsed.data.note?.trim())) {
      return NextResponse.json({ error: "invalid_recovery_request" }, { status: 400 });
    }
    if (!session.session.walletAddress) {
      return NextResponse.json({ error: "authenticated_wallet_required" }, { status: 403 });
    }

    const run = await getWorkspacePayrollRun(db, workspaceId, runId);
    const allocation = run?.allocations.find((item) => item.id === allocationId);
    if (!allocation || !allocation.claimAddress) {
      return NextResponse.json({ error: "payroll_allocation_not_found" }, { status: 404 });
    }
    if (allocation.status !== "unclaimed") {
      return NextResponse.json({ error: "payroll_allocation_not_recoverable" }, { status: 409 });
    }

    const note = parsed.data.reason === "other" ? parsed.data.note!.trim() : null;
    const commitment = reasonCommitment(parsed.data.reason, note);
    await verifyPayrollRecoveryTransaction({
      signature: parsed.data.signature,
      authorityAddress: session.session.walletAddress,
      workspaceId,
      contributorAddress: allocation.contributorWalletAddress,
      claimId: allocation.claimId,
      claimAddress: allocation.claimAddress,
      allocationCommitment: run.run.allocationCommitment ?? "",
      recoveryReasonCommitment: commitment
    });

    const result = await recordPayrollRecovery(db, {
      workspaceId,
      runId,
      allocationId,
      actorUserId: session.session.userId,
      reason: parsed.data.reason,
      reasonNote: note,
      signature: parsed.data.signature,
      claimAddress: allocation.claimAddress
    });
    if (result.status === "not_found") {
      return NextResponse.json({ error: "payroll_allocation_not_found" }, { status: 404 });
    }
    if (result.status === "conflict") {
      return NextResponse.json({ error: "payroll_allocation_changed" }, { status: 409 });
    }
    return NextResponse.json({
      status: result.status === "duplicate" ? "already_reconciled" : "recovered",
      signature: parsed.data.signature,
      valueTransferred: false
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return NextResponse.json({ error: "request_not_allowed" }, { status: 403 });
    }
    console.error(JSON.stringify({ event: "payroll_recovery_submission_failed" }));
    return NextResponse.json({ error: "payroll_recovery_submission_failed" }, { status: 503 });
  }
}
