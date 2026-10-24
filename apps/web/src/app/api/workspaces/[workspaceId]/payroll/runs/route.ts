import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import {
  createPayrollDraft,
  getWorkspaceDeletionState,
  getWorkspaceForUser,
  getWorkspaceSubscription,
  listWorkspaceContributors,
  listWorkspacePayrollRuns
} from "@paylore/database";
import { clearSessionCookie, getSessionState } from "../../../../../../server/session";
import { assertSameOrigin, RequestSecurityError } from "../../../../../../server/security";
import { getDatabase } from "../../../../../../server/db";
import { loadPayloreConfig } from "../../../../../../server/config";
import { derivePayrollAmountCommitmentMaterial } from "../../../../../../server/solana/payroll-amount-commitment";
import { buildPayrollAllocationMerkleTree } from "../../../../../../server/solana/payroll-allocation-merkle";
import {
  previewPayrollFile,
  type PayrollContributor
} from "../../../../../../server/payroll-parser";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

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

export async function GET(_request: Request, { params }: RouteContext) {
  const { workspaceId } = await params;
  const access = await authorize(workspaceId);
  if ("response" in access) return access.response;
  const runs = await listWorkspacePayrollRuns(access.db, workspaceId);
  return NextResponse.json({ runs }, {
    headers: { "Cache-Control": "no-store" }
  });
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    assertSameOrigin(request);
    const { workspaceId } = await params;
    const access = await authorize(workspaceId);
    if ("response" in access) return access.response;
    if (access.membership.role !== "organization_admin") {
      return NextResponse.json(
        { error: "workspace_access_denied" },
        { status: 403 }
      );
    }
    const subscription = await getWorkspaceSubscription(
      access.db,
      workspaceId
    );
    if (
      subscription?.status !== "active" &&
      subscription?.status !== "cancel_scheduled"
    ) {
      return NextResponse.json(
        { error: "workspace_read_only" },
        { status: 409 }
      );
    }

    if (Number(request.headers.get("content-length") ?? 0) > 5 * 1024 * 1024 + 4096) {
      return NextResponse.json({ error: "file_too_large" }, { status: 413 });
    }
    const form = await request.formData();
    const file = form.get("file");
    const action = form.get("action");
    const idempotencyValue = form.get("idempotencyKey");
    const confirmedDigest = form.get("previewDigest");
    if (!(file instanceof File)) {
      return NextResponse.json({ error: "file_required" }, { status: 400 });
    }
    if (file.size > 5 * 1024 * 1024) {
      return NextResponse.json({ error: "file_too_large" }, { status: 413 });
    }
    if (action !== "preview" && action !== "confirm") {
      return NextResponse.json({ error: "invalid_action" }, { status: 400 });
    }
    if (action === "confirm") {
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
    const contributors = await listWorkspaceContributors(
      access.db,
      workspaceId
    );
    const contributorMap = new Map<string, PayrollContributor>(
      contributors
        .filter((contributor) =>
          contributor.lifecycle === "active" &&
          contributor.role === "contributor"
        )
        .map((contributor) => [
          contributor.identityWalletAddress,
          {
            id: contributor.id,
            displayName: contributor.displayName,
            identityWalletAddress: contributor.identityWalletAddress
          }
        ])
    );
    const preview = await previewPayrollFile(
      file.name,
      Buffer.from(await file.arrayBuffer()),
      contributorMap
    );
    const rows = preview.rows.flatMap((row) =>
      row.value ? [row.value] : []
    );
    const canonicalRows = [...rows].sort((a, b) =>
      a.identityWalletAddress.localeCompare(b.identityWalletAddress)
    );
    const importDigest = createHash("sha256")
      .update(JSON.stringify(canonicalRows))
      .digest("hex");
    if (action === "preview") {
      return NextResponse.json(
        {
          status:
            preview.errorCount > 0 || preview.validCount === 0
              ? "review_required"
              : "preview_ready",
          importDigest,
          preview
        },
        {
          status:
            preview.errorCount > 0 || preview.validCount === 0 ? 422 : 200,
          headers: { "Cache-Control": "no-store" }
        }
      );
    }
    if (
      typeof idempotencyValue !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(idempotencyValue)
    ) {
      return NextResponse.json(
        { error: "valid_idempotency_key_required" },
        { status: 400 }
      );
    }
    if (preview.errorCount > 0 || preview.validCount === 0) {
      return NextResponse.json(
        { status: "review_required", preview },
        { status: 422 }
      );
    }
    if (
      typeof confirmedDigest !== "string" ||
      confirmedDigest !== importDigest
    ) {
      return NextResponse.json(
        { error: "preview_changed_reconfirm_required", preview },
        { status: 409 }
      );
    }
    const commitmentSecret = loadPayloreConfig().PAYLORE_PAYROLL_AMOUNT_COMMITMENT_SECRET;
    if (!commitmentSecret) {
      return NextResponse.json(
        { error: "payroll_amount_commitment_not_configured" },
        { status: 503, headers: { "Cache-Control": "no-store" } }
      );
    }
    const committedRows = canonicalRows.map((row) => {
      const claimId = createHash("sha256")
        .update(`${workspaceId}:${idempotencyValue}:${row.contributorId}`)
        .digest("hex");
      const amountCommitment = derivePayrollAmountCommitmentMaterial({
        amountBaseUnits: row.amountBaseUnits,
        claimId,
        secretHex: commitmentSecret
      }).amountCommitment;
      return {
        contributorId: row.contributorId,
        identityWalletAddress: row.identityWalletAddress,
        amountBaseUnits: row.amountBaseUnits,
        amountCommitment,
        claimId
      };
    });
    const merkleTree = buildPayrollAllocationMerkleTree(committedRows.map((row) => ({
      claimId: row.claimId,
      contributorAddress: row.identityWalletAddress,
      amountCommitment: row.amountCommitment
    })));
    const allocationCommitment = merkleTree.allocationCommitment;
    const allocationInputs = committedRows.map((row) => {
      const proof = merkleTree.proofs.find((candidate) => candidate.claimId === row.claimId);
      if (!proof) throw new Error("The allocation Merkle proof could not be derived.");
      return {
        contributorId: row.contributorId,
        amountBaseUnits: row.amountBaseUnits,
        amountCommitment: row.amountCommitment,
        amountCommitmentProof: proof.siblings,
        amountCommitmentLeafIndex: proof.leafIndex,
        claimId: row.claimId
      };
    });
    const saved = await createPayrollDraft(access.db, {
      workspaceId,
      createdByUserId: access.session.userId,
      idempotencyKey: idempotencyValue,
      importDigest,
      allocationCommitment,
      totalAmountBaseUnits: preview.totalBaseUnits,
      allocations: allocationInputs
    });

    return NextResponse.json(
      {
        status: saved.run.status,
        runId: saved.run.id,
        duplicate: !saved.created,
        totalAmountBaseUnits: saved.run.totalAmountBaseUnits,
        allocationCount: saved.allocations.length,
        preview
      },
      { headers: { "Cache-Control": "no-store" } }
    );
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
    if (error instanceof Error && /file|CSV|XLSX|column|worksheet|quoted|payroll/i.test(error.message)) {
      return NextResponse.json(
        { error: "payroll_file_could_not_be_processed" },
        { status: 400 }
      );
    }
    console.error(JSON.stringify({ event: "payroll_draft_creation_failed" }));
    return NextResponse.json(
      { error: "payroll_draft_creation_failed" },
      { status: 503 }
    );
  }
}
