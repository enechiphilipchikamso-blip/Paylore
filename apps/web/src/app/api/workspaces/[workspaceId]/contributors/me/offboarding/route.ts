import { NextResponse } from "next/server";
import { z } from "zod";
import {
  completeContributorOffboarding,
  getCompletedContributorOffboardingByWallet,
  findWorkspaceContributorByWallet,
  getContributorConfidentialAccount,
  getWorkspaceForUser,
  hasOpenContributorPayrollAllocations
} from "@paylore/database";
import { getDatabase } from "../../../../../../../server/db";
import { clearSessionCookie, getSessionState } from "../../../../../../../server/session";
import { assertSameOrigin, RequestSecurityError } from "../../../../../../../server/security";
import { loadPayloreConfig } from "../../../../../../../server/config";
import {
  ConfidentialAccountVerificationError,
  verifyConfidentialAccountClose
} from "../../../../../../../server/solana/confidential-account-verification";

const preflightSchema = z.object({ action: z.literal("preflight") }).strict();
const leaveSchema = z.object({
  acknowledgement: z.literal("Acknowledge & Leave Workspace"),
  closeTransactionSignature: z.string().min(80).max(90).nullable()
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
    const rawBody = await request.text();
    if (rawBody.length > 2048) {
      return NextResponse.json({ error: "request_too_large" }, { status: 413 });
    }
    let raw: unknown;
    try {
      raw = JSON.parse(rawBody);
    } catch {
      return NextResponse.json({ error: "offboarding_confirmation_required" }, { status: 400 });
    }
    const preflight = preflightSchema.safeParse(raw);
    const parsed = leaveSchema.safeParse(raw);
    if (!preflight.success && !parsed.success) {
      return NextResponse.json({ error: "offboarding_confirmation_required" }, { status: 400 });
    }
    const { workspaceId } = await params;
    const session = await getSessionState();
    if (session.status !== "authenticated") {
      await clearSessionCookie();
      return NextResponse.json(
        { error: "authentication_required" },
        { status: 401 }
      );
    }

    const db = getDatabase();
    if (parsed.success) {
      const completed = await getCompletedContributorOffboardingByWallet(db, {
        workspaceId,
        userId: session.session.userId,
        walletAddress: session.session.walletAddress
      });
      if (completed) {
        return NextResponse.json({
          status: "left_workspace",
          replayed: true,
          manualAccountClose: completed.manualAccountClose === true
        }, { headers: { "Cache-Control": "no-store" } });
      }
    }
    const membership = await getWorkspaceForUser(
      db,
      session.session.userId,
      workspaceId
    );
    if (!membership || membership.role !== "contributor") {
      return NextResponse.json(
        { error: "workspace_access_denied" },
        { status: 403 }
      );
    }
    const contributor = await findWorkspaceContributorByWallet(
      db,
      workspaceId,
      session.session.walletAddress
    );
    if (!contributor || contributor.lifecycle === "left") {
      return NextResponse.json(
        { error: "contributor_record_not_found" },
        { status: 404 }
      );
    }
    if (preflight.success) {
      const hasOpenAllocations = await hasOpenContributorPayrollAllocations(db, workspaceId, contributor.id);
      if (hasOpenAllocations) {
        return NextResponse.json({ error: "outstanding_compensation_obligation" }, { status: 409 });
      }
      const account = await getContributorConfidentialAccount(db, workspaceId, contributor.id);
      if (account?.status === "ready" && account.ownerWalletAddress !== session.session.walletAddress) {
        return NextResponse.json({ error: "confidential_account_owner_mismatch" }, { status: 409 });
      }
      return NextResponse.json({
        status: "eligible_to_leave",
        requiresConfidentialAccountClose: account?.status === "ready"
      }, { headers: { "Cache-Control": "no-store" } });
    }
    if (!parsed.success) {
      return NextResponse.json({ error: "offboarding_confirmation_required" }, { status: 400 });
    }
    if (
      await hasOpenContributorPayrollAllocations(
        db,
        workspaceId,
        contributor.id
      )
    ) {
      return NextResponse.json(
        { error: "outstanding_compensation_obligation" },
        { status: 409 }
      );
    }

    const account = await getContributorConfidentialAccount(
      db,
      workspaceId,
      contributor.id
    );
    let closeTransactionSignature: string | null = null;
    if (account?.status === "ready") {
      if (!parsed.data.closeTransactionSignature) {
        return NextResponse.json(
          { error: "confidential_account_close_required" },
          { status: 409 }
        );
      }
      const mint = loadPayloreConfig().PAYLORE_WRAPPED_USDC_MINT;
      if (!mint) {
        return NextResponse.json(
          { error: "confidential_mint_unavailable" },
          { status: 503 }
        );
      }
      const closedToken = await verifyConfidentialAccountClose({
        signature: parsed.data.closeTransactionSignature,
        walletAddress: session.session.walletAddress,
        mintAddress: mint
      });
      if (closedToken !== account.tokenAccountAddress) {
        return NextResponse.json(
          { error: "confidential_account_close_mismatch" },
          { status: 409 }
        );
      }
      closeTransactionSignature = parsed.data.closeTransactionSignature;
    } else if (parsed.data.closeTransactionSignature) {
      return NextResponse.json(
        { error: "confidential_account_close_mismatch" },
        { status: 409 }
      );
    }

    const outcome = await completeContributorOffboarding(db, {
      workspaceId,
      contributorId: contributor.id,
      userId: session.session.userId,
      walletAddress: session.session.walletAddress,
      closeTransactionSignature
    });
    if (outcome === "outstanding_obligations") {
      return NextResponse.json(
        { error: "outstanding_compensation_obligation" },
        { status: 409 }
      );
    }
    if (outcome === "already_completed") {
      const completed = await getCompletedContributorOffboardingByWallet(db, {
        workspaceId,
        userId: session.session.userId,
        walletAddress: session.session.walletAddress
      });
      return NextResponse.json({
        status: "left_workspace",
        replayed: true,
        manualAccountClose: completed?.manualAccountClose === true
      }, { headers: { "Cache-Control": "no-store" } });
    }
    if (outcome !== "completed") {
      return NextResponse.json(
        { error: "contributor_offboarding_unavailable" },
        { status: 409 }
      );
    }
    return NextResponse.json(
      {
        status: "left_workspace",
        replayed: false,
        manualAccountClose: Boolean(closeTransactionSignature)
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof ConfidentialAccountVerificationError) {
      return NextResponse.json({ error: error.code }, { status: 409 });
    }
    if (error instanceof RequestSecurityError) {
      return NextResponse.json({ error: "request_not_allowed" }, { status: 403 });
    }
    console.error(JSON.stringify({ event: "contributor_offboarding_failed" }));
    return NextResponse.json(
      { error: "contributor_offboarding_failed" },
      { status: 503 }
    );
  }
}
