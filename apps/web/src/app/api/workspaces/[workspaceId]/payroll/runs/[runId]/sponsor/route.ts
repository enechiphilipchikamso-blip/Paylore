import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  beginGasTankOperationAttempt,
  getWorkspaceGasTankOperation,
  getWorkspaceGasTankOperationByIdempotencyKey,
  getWorkspaceDeletionState,
  getWorkspaceForUser,
  getWorkspaceGasTankSponsorshipUsage,
  getWorkspacePayrollRun,
  getWorkspaceSubscription,
  recordPayrollClaimSubmission,
  updateGasTankOperationAttempt
} from "@paylore/database";
import { clearSessionCookie, getSessionState } from "../../../../../../../../server/session";
import { getDatabase } from "../../../../../../../../server/db";
import { assertSameOrigin, RequestSecurityError } from "../../../../../../../../server/security";
import { loadPayloreConfig } from "../../../../../../../../server/config";
import {
  getWorkspaceGasTankSnapshot,
  withWorkspaceGasTankKey
} from "../../../../../../../../server/gas-tank";
import {
  assertSponsoredClaimIntent,
  GasTankSponsorshipPolicyError,
  MAX_DAILY_SPONSORED_FEE_LAMPORTS,
  MAX_DAILY_SPONSORED_OPERATIONS,
  MAX_SPONSORED_FEE_LAMPORTS
} from "../../../../../../../../server/gas-tank-sponsorship-policy";
import { prepareSponsoredPayrollClaimTransaction } from "../../../../../../../../server/gas-tank-sponsorship";
import { readSolanaRpc } from "../../../../../../../../server/solana/rpc";
import { classifyPreparedSponsorshipState } from "../../../../../../../../server/gas-tank-sponsorship-policy";
import { verifyPayrollClaimTransaction } from "../../../../../../../../server/solana/payroll-program-verification";

type RouteContext = {
  params: Promise<{ workspaceId: string; runId: string }>;
};
const idSchema = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
const requestSchema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("prepare"),
    claimIds: z.array(z.string().regex(/^[0-9a-f]{64}$/i)).min(1).max(4)
  }).strict(),
  z.object({
    action: z.literal("cancel"),
    operationId: idSchema
  }).strict()
]);
const MAX_REQUEST_BYTES = 4_096;

async function readBoundedRequestText(
  request: Request,
  maxBytes: number
): Promise<string | null> {
  const contentLength = request.headers.get("content-length");
  if (contentLength && /^\d+$/.test(contentLength) &&
      Number(contentLength) > maxBytes) {
    return null;
  }
  if (!request.body) return "";

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;
  let exceeded = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > maxBytes) {
        exceeded = true;
        await reader.cancel().catch(() => undefined);
        break;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (exceeded) return null;

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

type PreparedSponsorshipData = {
  runId: string;
  claimIds: string[];
  authorityAddress: string;
  programId: string;
  allocationCommitment: string;
  claims: Array<{ claimId: string; claimAddress: string }>;
  blockhash: string;
  transactionBase64: string;
};

function parsePreparedSponsorshipData(value: unknown): PreparedSponsorshipData | null {
  if (!value || typeof value !== "object") return null;
  const data = value as Record<string, unknown>;
  if (
    typeof data.runId !== "string" ||
    !Array.isArray(data.claimIds) ||
    !data.claimIds.every((id) => typeof id === "string") ||
    typeof data.authorityAddress !== "string" ||
    typeof data.programId !== "string" ||
    typeof data.allocationCommitment !== "string" ||
    !Array.isArray(data.claims) ||
    !data.claims.every((claim) => {
      if (!claim || typeof claim !== "object") return false;
      const record = claim as Record<string, unknown>;
      return typeof record.claimId === "string" && typeof record.claimAddress === "string";
    }) ||
    typeof data.blockhash !== "string" ||
    typeof data.transactionBase64 !== "string"
  ) return null;
  return data as unknown as PreparedSponsorshipData;
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: RouteContext) {
  let operationForFailure: { workspaceId: string; operationId: string } | null = null;
  try {
    assertSameOrigin(request);
    const text = await readBoundedRequestText(request, MAX_REQUEST_BYTES);
    if (text === null) {
      return NextResponse.json({ error: "request_too_large" }, { status: 413 });
    }
    let raw: unknown;
    try { raw = JSON.parse(text); } catch {
      return NextResponse.json({ error: "invalid_sponsorship_request" }, { status: 400 });
    }
    const parsed = requestSchema.safeParse(raw);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_sponsorship_request" }, { status: 400 });
    }
    const { workspaceId, runId } = await params;
    const session = await getSessionState();
    if (session.status !== "authenticated") {
      await clearSessionCookie();
      return NextResponse.json({ error: "authentication_required" }, { status: 401 });
    }
    const db = getDatabase();
    const membership = await getWorkspaceForUser(db, session.session.userId, workspaceId);
    if (!membership || membership.role !== "organization_admin" || !session.session.walletAddress) {
      return NextResponse.json({ error: "workspace_access_denied" }, { status: 403 });
    }

    if (parsed.data.action === "cancel") {
      const operation = await getWorkspaceGasTankOperation(db, workspaceId, parsed.data.operationId);
      if (!operation) return NextResponse.json({ error: "sponsorship_operation_not_found" }, { status: 404 });
      if (operation.status === "cancelled") {
        return NextResponse.json({ status: "cancelled" }, { headers: { "Cache-Control": "no-store" } });
      }
      if (operation.status === "preparing" && !operation.transactionSignature) {
        const cancelled = await updateGasTankOperationAttempt(db, {
          workspaceId, operationId: operation.id, status: "cancelled", failureCode: "wallet_user_cancelled"
        });
        return cancelled
          ? NextResponse.json({ status: "cancelled" }, { headers: { "Cache-Control": "no-store" } })
          : NextResponse.json({ error: "sponsorship_operation_not_cancellable" }, { status: 409 });
      }
      if (operation.status !== "prepared" || !operation.transactionSignature || !operation.lastValidBlockHeight) {
        return NextResponse.json({ error: "sponsorship_operation_not_cancellable" }, { status: 409 });
      }
      const [statuses, currentBlockHeight] = await Promise.all([
        readSolanaRpc<{ value: Array<{ confirmationStatus?: string | null; err?: unknown } | null> }>(
          "getSignatureStatuses", [[operation.transactionSignature], { searchTransactionHistory: true }]
        ),
        readSolanaRpc<number>("getBlockHeight", [{ commitment: "finalized" }])
      ]);
      const state = classifyPreparedSponsorshipState({
        currentBlockHeight,
        lastValidBlockHeight: Number(operation.lastValidBlockHeight),
        signatureStatus: Array.isArray(statuses.value) ? statuses.value[0] ?? null : null
      });
      if (state !== "expired") {
        return NextResponse.json({
          error: state === "finalized_success" || state === "finalized_failure"
            ? "sponsorship_transaction_already_submitted"
            : state === "submitted_pending" ? "sponsorship_transaction_pending_finality" : "sponsorship_transaction_still_live"
        }, { status: 409, headers: { "Cache-Control": "no-store" } });
      }
      const cancelled = await updateGasTankOperationAttempt(db, {
        workspaceId, operationId: operation.id, status: "cancelled", failureCode: "recent_blockhash_expired"
      });
      return cancelled
        ? NextResponse.json({ status: "cancelled", reason: "recent_blockhash_expired" }, { headers: { "Cache-Control": "no-store" } })
        : NextResponse.json({ error: "sponsorship_operation_state_changed" }, { status: 409 });
    }

    const deletion = await getWorkspaceDeletionState(db, workspaceId);
    if (deletion?.deletionScheduledAt && !deletion.deletionCanceledAt) {
      return NextResponse.json({ error: "workspace_deletion_pending" }, { status: 409 });
    }
    const subscription = await getWorkspaceSubscription(db, workspaceId);
    if (subscription?.status !== "active" && subscription?.status !== "cancel_scheduled") {
      return NextResponse.json({ error: "workspace_read_only" }, { status: 409 });
    }
    const config = loadPayloreConfig();
    const programId = config.PAYLORE_PAYROLL_PROGRAM_ID;
    if (!programId) return NextResponse.json({ error: "payroll_program_not_configured" }, { status: 503 });

    const run = await getWorkspacePayrollRun(db, workspaceId, runId);
    if (!run) return NextResponse.json({ error: "payroll_run_not_found" }, { status: 404 });
    if (!run.run.managerConfirmedAt || !run.run.allocationCommitment ||
        !["commit_pending", "submitting", "committed"].includes(run.run.status)) {
      return NextResponse.json({ error: "payroll_run_not_confirmed" }, { status: 409 });
    }
    const claimIds = parsed.data.claimIds.map((id) => id.toLowerCase()).sort();
    if (new Set(claimIds).size !== claimIds.length) {
      return NextResponse.json({ error: "sponsored_claims_duplicate" }, { status: 400 });
    }
    const selected = claimIds.map((claimId) =>
      run.allocations.find((allocation) => allocation.claimId?.toLowerCase() === claimId)
    );
    if (selected.some((allocation) => !allocation || !allocation.contributorWalletAddress)) {
      return NextResponse.json({ error: "sponsored_claim_allocation_not_eligible" }, { status: 409 });
    }
    const claims = selected.map((allocation) => ({
      claimId: allocation!.claimId!,
      contributorAddress: allocation!.contributorWalletAddress!,
    }));
    assertSponsoredClaimIntent({
      operation: "payroll_claim_commitment",
      workspaceId,
      requestedWorkspaceId: workspaceId,
      sessionWallet: session.session.walletAddress,
      authorityAddress: session.session.walletAddress,
      managerConfirmed: Boolean(run.run.managerConfirmedAt),
      runCommitment: run.run.allocationCommitment,
      claims
    });

    const tank = await getWorkspaceGasTankSnapshot(db, workspaceId);
    if (!tank) return NextResponse.json({ error: "gas_tank_not_initialized" }, { status: 409 });
    const now = new Date();
    const usage = await getWorkspaceGasTankSponsorshipUsage(
      db,
      workspaceId,
      new Date(now.getTime() - 24 * 60 * 60 * 1000)
    );
    const requestDigest = createHash("sha256").update(JSON.stringify({
      workspaceId,
      runId,
      authorityAddress: session.session.walletAddress,
      programId,
      allocationCommitment: run.run.allocationCommitment,
      claimIds
    })).digest("hex");
    const idempotencyKey = "payroll-claim:" + runId + ":" + createHash("sha256")
      .update(claimIds.join(":")).digest("hex");
    const reconcileVerifiedSponsorship = async (
      operationId: string,
      signature: string,
      data: PreparedSponsorshipData
    ) => {
      if (
        data.runId !== runId ||
        data.claimIds.join(":") !== claimIds.join(":") ||
        data.authorityAddress !== session.session.walletAddress ||
        data.programId !== programId ||
        data.allocationCommitment !== run.run.allocationCommitment ||
        data.claims.length !== claimIds.length ||
        data.claims.some((claim, index) => claim.claimId.toLowerCase() !== claimIds[index])
      ) {
        return null;
      }
      const expectedClaims = data.claims.map((claim) => {
        const allocation = run.allocations.find((item) =>
          item.claimId?.toLowerCase() === claim.claimId.toLowerCase()
        );
        if (!allocation?.contributorWalletAddress) return null;
        return {
          claimId: claim.claimId,
          claimAddress: claim.claimAddress,
          contributorAddress: allocation.contributorWalletAddress
        };
      });
      if (expectedClaims.some((claim) => claim === null)) return null;
      await verifyPayrollClaimTransaction({
        signature,
        authorityAddress: data.authorityAddress,
        workspaceId,
        allocationCommitment: data.allocationCommitment,
        claims: expectedClaims as Array<{
          claimId: string;
          claimAddress: string;
          contributorAddress: string;
        }>
      });
      const markedFinal = await updateGasTankOperationAttempt(db, {
        workspaceId,
        operationId,
        status: "finalized",
        transactionSignature: signature
      });
      if (!markedFinal) return null;
      const recorded = await recordPayrollClaimSubmission(db, {
        workspaceId,
        runId,
        signature,
        claims: data.claims
      });
      if (recorded.status !== "committed" && recorded.status !== "submitting") return null;
      return recorded;
    };

    const priorOperation = await getWorkspaceGasTankOperationByIdempotencyKey(db, workspaceId, idempotencyKey);
    if (priorOperation) {
      if (priorOperation.requestDigest !== requestDigest) {
        return NextResponse.json({ error: "sponsorship_idempotency_conflict" }, { status: 409 });
      }
      if (priorOperation.status === "preparing") {
        const staleAfterMs = 2 * 60 * 1000;
        const updatedAt = priorOperation.updatedAt instanceof Date
          ? priorOperation.updatedAt.getTime()
          : new Date(priorOperation.updatedAt).getTime();
        if (
          !priorOperation.transactionSignature &&
          Number.isFinite(updatedAt) &&
          Date.now() - updatedAt > staleAfterMs
        ) {
          const expiredPreparation = await updateGasTankOperationAttempt(db, {
            workspaceId,
            operationId: priorOperation.id,
            status: "failed",
            failureCode: "preparation_expired_without_submission",
            feeLamports: "0"
          });
          if (!expiredPreparation) {
            return NextResponse.json({ error: "gas_tank_operation_preparing" }, { status: 409 });
          }
        } else {
          return NextResponse.json({ error: "gas_tank_operation_preparing" }, { status: 409 });
        }
      } else if (priorOperation.status === "prepared" || priorOperation.status === "finalized") {
        const data = parsePreparedSponsorshipData(priorOperation.operationData);
        if (
          !priorOperation.transactionSignature ||
          !priorOperation.lastValidBlockHeight ||
          !data
        ) {
          return NextResponse.json({ error: "sponsorship_operation_reconciliation_data_missing" }, { status: 409 });
        }

        if (priorOperation.status === "finalized") {
          try {
            const reconciled = await reconcileVerifiedSponsorship(
              priorOperation.id,
              priorOperation.transactionSignature,
              data
            );
            if (!reconciled) {
              return NextResponse.json({ error: "sponsorship_operation_reconciliation_conflict" }, { status: 409 });
            }
            return NextResponse.json({
              status: "reconciled",
              signature: priorOperation.transactionSignature,
              replayed: true,
              submittedCount: reconciled.submittedCount,
              totalCount: reconciled.totalCount
            }, { headers: { "Cache-Control": "no-store" } });
          } catch {
            return NextResponse.json({ error: "sponsorship_finalized_transaction_verification_failed" }, { status: 409 });
          }
        }

        const [statuses, blockHeight] = await Promise.all([
          readSolanaRpc<{ value: Array<{ confirmationStatus?: string | null; err?: unknown } | null> }>(
            "getSignatureStatuses",
            [[priorOperation.transactionSignature], { searchTransactionHistory: true }]
          ),
          readSolanaRpc<number>("getBlockHeight", [{ commitment: "finalized" }])
        ]);
        const state = classifyPreparedSponsorshipState({
          currentBlockHeight: blockHeight,
          lastValidBlockHeight: Number(priorOperation.lastValidBlockHeight),
          signatureStatus: Array.isArray(statuses.value) ? statuses.value[0] ?? null : null
        });

        if (state === "live" && run.run.status === "committed") {
          return NextResponse.json(
            { error: "payroll_run_already_committed" },
            { status: 409, headers: { "Cache-Control": "no-store" } }
          );
        }

        if (
          state === "live" &&
          data.runId === runId &&
          data.claimIds.join(":") === claimIds.join(":") &&
          data.authorityAddress === session.session.walletAddress &&
          data.programId === programId &&
          data.allocationCommitment === run.run.allocationCommitment
        ) {
          return NextResponse.json({
            status: "prepared",
            operationId: priorOperation.id,
            idempotencyKey,
            transactionBase64: data.transactionBase64,
            signature: priorOperation.transactionSignature,
            feeLamports: priorOperation.feeLamports,
            gasTankAddress: tank.address,
            claims: data.claims,
            blockhash: data.blockhash,
            lastValidBlockHeight: Number(priorOperation.lastValidBlockHeight),
            replayed: true
          }, { headers: { "Cache-Control": "no-store" } });
        }
        if (state === "submitted_pending") {
          return NextResponse.json({ error: "sponsorship_transaction_pending_finality" }, { status: 409, headers: { "Cache-Control": "no-store" } });
        }
        if (state === "finalized_success") {
          try {
            const reconciled = await reconcileVerifiedSponsorship(
              priorOperation.id,
              priorOperation.transactionSignature,
              data
            );
            if (!reconciled) {
              return NextResponse.json({ error: "sponsorship_operation_reconciliation_conflict" }, { status: 409 });
            }
            return NextResponse.json({
              status: "reconciled",
              signature: priorOperation.transactionSignature,
              replayed: true,
              submittedCount: reconciled.submittedCount,
              totalCount: reconciled.totalCount
            }, { headers: { "Cache-Control": "no-store" } });
          } catch {
            return NextResponse.json({ error: "sponsorship_finalized_transaction_verification_failed" }, { status: 409 });
          }
        }
        if (state === "finalized_failure") {
          const transaction = await readSolanaRpc<{
            meta?: { err?: unknown; fee?: unknown } | null;
          } | null>("getTransaction", [
            priorOperation.transactionSignature,
            { commitment: "finalized", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }
          ]);
          if (
            !transaction?.meta ||
            transaction.meta.err === null ||
            typeof transaction.meta.fee !== "number" ||
            !Number.isSafeInteger(transaction.meta.fee) ||
            transaction.meta.fee < 0
          ) {
            return NextResponse.json({ error: "sponsorship_failed_transaction_fee_unavailable" }, { status: 503 });
          }
          const released = await updateGasTankOperationAttempt(db, {
            workspaceId,
            operationId: priorOperation.id,
            status: "failed",
            transactionSignature: priorOperation.transactionSignature,
            feeLamports: String(transaction.meta.fee),
            failureCode: "finalized_chain_failure"
          });
          if (!released) {
            return NextResponse.json({ error: "sponsorship_operation_state_changed" }, { status: 409 });
          }
          return NextResponse.json({
            error: run.run.status === "committed"
              ? "payroll_run_already_committed"
              : "previous_sponsored_transaction_failed_retry_allowed",
            signature: priorOperation.transactionSignature,
            feeLamports: String(transaction.meta.fee)
          }, { status: 409, headers: { "Cache-Control": "no-store" } });
        }
        if (state === "expired") {
          const released = await updateGasTankOperationAttempt(db, {
            workspaceId,
            operationId: priorOperation.id,
            status: "cancelled",
            transactionSignature: priorOperation.transactionSignature,
            failureCode: "recent_blockhash_expired"
          });
          if (!released) {
            return NextResponse.json({ error: "sponsorship_operation_state_changed" }, { status: 409 });
          }
        }
      } else if (priorOperation.status === "cancelled" || priorOperation.status === "failed") {
        // A new preparation is permitted only for an operation proven not to have finalized successfully.
      } else {
        return NextResponse.json({ error: "gas_tank_operation_already_prepared" }, { status: 409 });
      }
    }

    if (run.run.status === "committed") {
      return NextResponse.json(
        { error: "payroll_run_already_committed" },
        { status: 409, headers: { "Cache-Control": "no-store" } }
      );
    }

    if (selected.some((allocation) => allocation?.status !== "draft")) {
      return NextResponse.json({ error: "sponsored_claim_allocation_not_eligible" }, { status: 409 });
    }

    const begun = await beginGasTankOperationAttempt(db, {
      workspaceId,
      idempotencyKey,
      operationType: "payroll_claim_commitment",
      requestDigest,
      reservedFeeLamports: String(MAX_SPONSORED_FEE_LAMPORTS),
      availableBalanceLamports: tank.balanceLamports,
      maxDailyFeeLamports: String(MAX_DAILY_SPONSORED_FEE_LAMPORTS),
      maxDailyOperations: MAX_DAILY_SPONSORED_OPERATIONS,
      since: new Date(now.getTime() - 24 * 60 * 60 * 1000),
      operationData: {
        runId, claimIds, authorityAddress: session.session.walletAddress,
        programId, allocationCommitment: run.run.allocationCommitment
      }
    });
    if (begun.status !== "started" || !begun.operation) {
      if (begun.status === "gas_tank_not_initialized") {
        return NextResponse.json({ error: "gas_tank_not_initialized" }, { status: 409 });
      }
      if (begun.status === "gas_tank_insufficient_balance") {
        return NextResponse.json({ error: "gas_tank_insufficient_balance" }, { status: 409 });
      }
      if (begun.status === "gas_tank_daily_sponsorship_limit") {
        return NextResponse.json({ error: "gas_tank_daily_sponsorship_limit" }, { status: 429 });
      }
      return NextResponse.json({
        error: begun.status === "finalized"
          ? "gas_tank_operation_already_finalized"
          : "gas_tank_operation_already_prepared"
      }, { status: 409 });
    }
    operationForFailure = { workspaceId, operationId: begun.operation.id };

    try {
      const prepared = await withWorkspaceGasTankKey(db, workspaceId, (privateKey) =>
        prepareSponsoredPayrollClaimTransaction({
          workspaceId,
          authorityAddress: session.session.walletAddress!,
          programId,
          gasTankAddress: tank.address,
          gasTankPrivateKey: privateKey,
          balanceLamports: tank.balanceLamports,
          allocationCommitment: run.run.allocationCommitment!,
          claims: claims.map(({ claimId, contributorAddress }) => ({
            claimId, contributorAddress
          })),
          dailyBookedFeesLamports: usage.feeLamports,
          dailyOperationCount: usage.operationCount
        })
      );
      const saved = await updateGasTankOperationAttempt(db, {
        workspaceId,
        operationId: begun.operation.id,
        status: "prepared",
        transactionSignature: prepared.signature,
        feeLamports: prepared.feeLamports,
        lastValidBlockHeight: String(prepared.lastValidBlockHeight),
        operationData: { runId, claimIds, authorityAddress: session.session.walletAddress, programId, allocationCommitment: run.run.allocationCommitment, claims: prepared.claims, blockhash: prepared.blockhash, transactionBase64: prepared.transactionBase64 }
      });
      if (!saved) throw new GasTankSponsorshipPolicyError("sponsorship_operation_state_changed");
      operationForFailure = null;
      return NextResponse.json({
        status: "prepared",
        operationId: begun.operation.id,
        idempotencyKey,
        transactionBase64: prepared.transactionBase64,
        signature: prepared.signature,
        feeLamports: prepared.feeLamports,
        gasTankAddress: prepared.gasTankAddress,
        claims: prepared.claims,
        blockhash: prepared.blockhash,
        lastValidBlockHeight: prepared.lastValidBlockHeight
      }, { headers: { "Cache-Control": "no-store" } });
    } catch (error) {
      await updateGasTankOperationAttempt(db, {
        workspaceId,
        operationId: begun.operation.id,
        status: "failed",
        failureCode: error instanceof GasTankSponsorshipPolicyError
          ? error.code
          : "sponsorship_preparation_failed",
        feeLamports: "0"
      });
      operationForFailure = null;
      throw error;
    }
  } catch (error) {
    if (operationForFailure) {
      const db = getDatabase();
      await updateGasTankOperationAttempt(db, {
        workspaceId: operationForFailure.workspaceId,
        operationId: operationForFailure.operationId,
        status: "failed",
        failureCode: "sponsorship_preparation_failed",
        feeLamports: "0"
      }).catch(() => undefined);
    }
    if (error instanceof RequestSecurityError) {
      return NextResponse.json({ error: "request_not_allowed" }, { status: 403 });
    }
    if (error instanceof GasTankSponsorshipPolicyError) {
      const status = error.code === "gas_tank_insufficient_balance" ? 409
        : error.code === "gas_tank_daily_sponsorship_limit" ? 429
        : error.code === "sponsored_simulation_failed" || error.code === "sponsored_simulation_unavailable" ? 503
        : 409;
      return NextResponse.json({ error: error.code }, { status });
    }
    console.error(JSON.stringify({ event: "gas_tank_sponsorship_failed" }));
    return NextResponse.json({ error: "gas_tank_sponsorship_failed" }, { status: 503 });
  }
}
