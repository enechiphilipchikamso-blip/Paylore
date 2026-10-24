import { NextResponse } from "next/server";
import {
  getWorkspaceForUser,
  getWorkspacePayrollRun,
  recordPayrollClaimSubmission,
  updateGasTankOperationAttempt
} from "@paylore/database";
import { clearSessionCookie, getSessionState } from "../../../../../../../../server/session";
import { getDatabase } from "../../../../../../../../server/db";
import { loadPayloreConfig } from "../../../../../../../../server/config";
import { assertSameOrigin, RequestSecurityError } from "../../../../../../../../server/security";
import { verifyPayrollClaimTransaction } from "../../../../../../../../server/solana/payroll-program-verification";

type RouteContext = {
  params: Promise<{ workspaceId: string; runId: string }>;
};

type SubmittedClaim = {
  claimId: string;
  claimAddress: string;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: RouteContext) {
  try {
    assertSameOrigin(request);
    const { workspaceId, runId } = await params;
    const session = await getSessionState();
    if (session.status !== "authenticated") {
      await clearSessionCookie();
      return NextResponse.json(
        { error: "authentication_required" },
        { status: 401 }
      );
    }
    const db = getDatabase();
    const workspace = await getWorkspaceForUser(
      db,
      session.session.userId,
      workspaceId
    );
    if (!workspace || workspace.role !== "organization_admin") {
      return NextResponse.json(
        { error: "workspace_access_denied" },
        { status: 403 }
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid_request" }, { status: 400 });
    }
    if (
      !body ||
      typeof body !== "object" ||
      !("signature" in body) ||
      typeof body.signature !== "string" ||
      !/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(body.signature) ||
      !("claims" in body) ||
      !Array.isArray(body.claims) ||
      body.claims.length === 0 ||
      body.claims.length > 4
    ) {
      return NextResponse.json(
        { error: "invalid_claim_submission" },
        { status: 400 }
      );
    }
    const submittedClaims = body.claims as SubmittedClaim[];
    if (
      submittedClaims.some(
        (claim) =>
          !claim ||
          typeof claim !== "object" ||
          typeof claim.claimId !== "string" ||
          !/^[0-9a-f]{64}$/i.test(claim.claimId) ||
          typeof claim.claimAddress !== "string" ||
          claim.claimAddress.length > 64
      ) ||
      new Set(submittedClaims.map((claim) => claim.claimId)).size !==
        submittedClaims.length ||
      ("sponsorOperationId" in body &&
        (typeof body.sponsorOperationId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.sponsorOperationId)))
    ) {
      return NextResponse.json(
        { error: "invalid_claim_submission" },
        { status: 400 }
      );
    }

    const payrollRun = await getWorkspacePayrollRun(db, workspaceId, runId);
    if (!payrollRun) {
      return NextResponse.json(
        { error: "payroll_run_not_found" },
        { status: 404 }
      );
    }
    const expectedClaims = submittedClaims.map((submitted) => {
      const allocation = payrollRun.allocations.find(
        (candidate) => candidate.claimId === submitted.claimId
      );
      if (!allocation) {
        throw new Error("Submitted allocation does not belong to this run.");
      }
      return {
        claimId: allocation.claimId,
        claimAddress: submitted.claimAddress,
        contributorAddress: allocation.contributorWalletAddress
      };
    });
    if (!payrollRun.run.allocationCommitment) {
      return NextResponse.json(
        { error: "payroll_run_not_committed" },
        { status: 409 }
      );
    }

    const programId = loadPayloreConfig().PAYLORE_PAYROLL_PROGRAM_ID;
    if (!programId) {
      return NextResponse.json(
        { error: "payroll_program_not_configured" },
        { status: 503 }
      );
    }
    try {
      await verifyPayrollClaimTransaction({
        signature: body.signature,
        authorityAddress: session.session.walletAddress,
        workspaceId,
        allocationCommitment: payrollRun.run.allocationCommitment,
        claims: expectedClaims
      });
    } catch (error) {
      if (
        error instanceof Error &&
        error.message === "The Devnet Payroll Program is not configured."
      ) {
        return NextResponse.json(
          { error: "payroll_program_not_configured" },
          { status: 503 }
        );
      }
      return NextResponse.json(
        { error: "payroll_claim_transaction_not_verified" },
        { status: 409 }
      );
    }

    if ("sponsorOperationId" in body) {
      const sponsorUpdated = await updateGasTankOperationAttempt(db, {
        workspaceId,
        operationId: body.sponsorOperationId as string,
        status: "finalized",
        transactionSignature: body.signature
      });
      if (!sponsorUpdated) {
        return NextResponse.json(
          { error: "sponsorship_operation_signature_mismatch" },
          { status: 409 }
        );
      }
    }

    const result = await recordPayrollClaimSubmission(db, {
      workspaceId,
      runId,
      signature: body.signature,
      programId,
      authorityAddress: session.session.walletAddress,
      claims: submittedClaims
    });
    if (result.status === "not_found") {
      return NextResponse.json(
        { error: "payroll_run_not_found" },
        { status: 404 }
      );
    }
    if (
      result.status !== "committed" &&
      result.status !== "submitting" &&
      result.status !== "duplicate"
    ) {
      return NextResponse.json(
        { error: "payroll_claim_state_conflict" },
        { status: 409 }
      );
    }
    return NextResponse.json(result, {
      headers: { "Cache-Control": "no-store" }
    });
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return NextResponse.json({ error: "request_not_allowed" }, { status: 403 });
    }
    if (error instanceof Error && error.message === "Submitted allocation does not belong to this run.") {
      return NextResponse.json(
        { error: "invalid_claim_submission" },
        { status: 400 }
      );
    }
    console.error(JSON.stringify({ event: "payroll_claim_submission_failed" }));
    return NextResponse.json(
      { error: "payroll_claim_submission_failed" },
      { status: 503 }
    );
  }
}
