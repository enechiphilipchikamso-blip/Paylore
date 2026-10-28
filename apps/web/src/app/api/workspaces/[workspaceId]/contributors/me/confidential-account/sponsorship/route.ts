import { createHash } from "node:crypto";
import { NextResponse } from "next/server";
import { z } from "zod";
import {
  beginGasTankOperationAttempt,
  findWorkspaceContributorByWallet,
  getContributorConfidentialAccount,
  getWorkspaceDeletionState,
  getWorkspaceForUser,
  getWorkspaceGasTankOperationByIdempotencyKey,
  getWorkspaceGasTankSponsorshipUsage,
  getWorkspaceSubscription,
  listPreparedGasTankConfidentialSetupOperations,
  updateGasTankOperationAttempt
} from "@paylore/database";
import { address } from "@solana/kit";
import { findAssociatedTokenPda, TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { clearSessionCookie, getSessionState } from "../../../../../../../../server/session";
import { assertSameOrigin, RequestSecurityError } from "../../../../../../../../server/security";
import { getDatabase } from "../../../../../../../../server/db";
import { loadPayloreConfig } from "../../../../../../../../server/config";
import { getWorkspaceGasTankSnapshot, withWorkspaceGasTankKey } from "../../../../../../../../server/gas-tank";
import { readSolanaRpc } from "../../../../../../../../server/solana/rpc";
import {
  assertSponsoredCost,
  GasTankSponsorshipPolicyError,
  MAX_CONFIDENTIAL_ACCOUNT_SETUP_RENT_LAMPORTS,
  MAX_DAILY_SPONSORED_FEE_LAMPORTS,
  MAX_DAILY_SPONSORED_OPERATIONS
} from "../../../../../../../../server/gas-tank-sponsorship-policy";
import {
  inspectSponsoredConfidentialSetupTransaction,
  submitSponsoredConfidentialSetupTransaction
} from "../../../../../../../../server/confidential-account-sponsorship";

const requestSchema = z.object({
  transactionBase64: z.string().min(1).max(4_096)
}).strict();
const MAX_REQUEST_BYTES = 5_000;
const idempotencyWindowMs = 24 * 60 * 60 * 1_000;

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function contributorContext(workspaceId: string) {
  const session = await getSessionState();
  if (session.status !== "authenticated") {
    await clearSessionCookie();
    return { response: NextResponse.json({ error: "authentication_required" }, { status: 401 }) };
  }
  if (!session.session.walletAddress) {
    return { response: NextResponse.json({ error: "contributor_wallet_required" }, { status: 403 }) };
  }
  const db = getDatabase();
  const membership = await getWorkspaceForUser(db, session.session.userId, workspaceId);
  if (!membership || membership.role !== "contributor") {
    return { response: NextResponse.json({ error: "workspace_access_denied" }, { status: 403 }) };
  }
  const contributor = await findWorkspaceContributorByWallet(
    db, workspaceId, session.session.walletAddress
  );
  if (!contributor || contributor.lifecycle === "left") {
    return { response: NextResponse.json({ error: "contributor_record_not_found" }, { status: 404 }) };
  }
  return { db, session: session.session, contributor };
}

async function currentPolicy(workspaceId: string, context: {
  db: ReturnType<typeof getDatabase>;
  contributor: { id: string };
  session: { walletAddress: string };
}, allowReadyAccount = false) {
  const [deletion, subscription, account] = await Promise.all([
    getWorkspaceDeletionState(context.db, workspaceId),
    getWorkspaceSubscription(context.db, workspaceId),
    getContributorConfidentialAccount(context.db, workspaceId, context.contributor.id)
  ]);
  if (deletion?.deletionScheduledAt && !deletion.deletionCanceledAt) {
    return { response: NextResponse.json({ error: "workspace_deletion_pending" }, { status: 409 }) };
  }
  if (subscription?.status !== "active" && subscription?.status !== "cancel_scheduled") {
    return { response: NextResponse.json({ error: "workspace_read_only" }, { status: 409 }) };
  }
  if (account?.status === "ready" && !allowReadyAccount) {
    return { response: NextResponse.json({ error: "confidential_account_already_ready" }, { status: 409 }) };
  }
  const config = loadPayloreConfig();
  if (!config.PAYLORE_WRAPPED_USDC_MINT) {
    return { response: NextResponse.json({ error: "confidential_setup_sponsorship_unavailable" }, { status: 503 }) };
  }
  const gasTank = await getWorkspaceGasTankSnapshot(context.db, workspaceId);
  if (!gasTank) {
    return { response: NextResponse.json({ error: "gas_tank_not_initialized" }, { status: 409 }) };
  }
  const [tokenAccountAddress] = await findAssociatedTokenPda({
    mint: address(config.PAYLORE_WRAPPED_USDC_MINT),
    owner: address(context.session.walletAddress),
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS
  });
  return {
    config,
    gasTank,
    tokenAccountAddress,
    feePayerAddress: gasTank.address,
    accountReady: account?.status === "ready"
  };
}

function readRecentBlockhashFromTransaction(value: unknown): string | null {
  if (value === null || typeof value !== "object") return null;
  const transaction = (value as Record<string, unknown>).transaction;
  if (transaction === null || typeof transaction !== "object") return null;
  const message = (transaction as Record<string, unknown>).message;
  if (message === null || typeof message !== "object") return null;
  const recentBlockhash = (message as Record<string, unknown>).recentBlockhash;
  return typeof recentBlockhash === "string" && recentBlockhash.length > 0
    ? recentBlockhash
    : null;
}

function readFinalizedTransactionError(value: unknown): { found: boolean; error: unknown } {
  if (value === null || typeof value !== "object") return { found: false, error: null };
  const meta = (value as Record<string, unknown>).meta;
  if (meta === null || typeof meta !== "object" || !("err" in meta)) {
    return { found: false, error: null };
  }
  return { found: true, error: (meta as Record<string, unknown>).err };
}

/** Releases a reservation only after status history and finalized transaction lookup agree it is absent. */
async function reconcilePreparedConfidentialSetupOperations(
  db: ReturnType<typeof getDatabase>,
  workspaceId: string,
  ownerAddress: string
): Promise<void> {
  const operations = await listPreparedGasTankConfidentialSetupOperations(db, workspaceId, ownerAddress);
  for (const operation of operations) {
    const signature = operation.transactionSignature;
    if (!signature) continue;

    const statuses = await readSolanaRpc<{
      value: Array<{ confirmationStatus?: string | null; err?: unknown } | null>
    }>("getSignatureStatuses", [[signature], { searchTransactionHistory: true }]);
    const status = Array.isArray(statuses.value) ? statuses.value[0] ?? null : null;
    if (status?.confirmationStatus === "finalized" && status.err === null) {
      await updateGasTankOperationAttempt(db, {
        workspaceId,
        operationId: operation.id,
        status: "finalized",
        transactionSignature: signature,
        feeLamports: operation.feeLamports,
        expectedUpdatedAt: operation.updatedAt
      });
      continue;
    }
    if (status?.confirmationStatus === "finalized" && status.err !== null) {
      await updateGasTankOperationAttempt(db, {
        workspaceId,
        operationId: operation.id,
        status: "failed",
        transactionSignature: signature,
        feeLamports: operation.feeLamports,
        failureCode: "finalized_chain_failure",
        expectedUpdatedAt: operation.updatedAt
      });
      continue;
    }
    if (status !== null) continue;

    const transaction = await readSolanaRpc<unknown>("getTransaction", [
      signature,
      { commitment: "finalized", maxSupportedTransactionVersion: 0 }
    ]);
    const finalResult = readFinalizedTransactionError(transaction);
    if (finalResult.found) {
      await updateGasTankOperationAttempt(db, {
        workspaceId,
        operationId: operation.id,
        status: finalResult.error === null ? "finalized" : "failed",
        transactionSignature: signature,
        feeLamports: operation.feeLamports,
        ...(finalResult.error === null ? {} : { failureCode: "finalized_chain_failure" }),
        expectedUpdatedAt: operation.updatedAt
      });
      continue;
    }
    if (transaction !== null) continue;

    const operationData = operation.operationData !== null &&
      typeof operation.operationData === "object" &&
      !Array.isArray(operation.operationData)
      ? operation.operationData as Record<string, unknown>
      : {};
    const recentBlockhash = typeof operationData.recentBlockhash === "string"
      ? operationData.recentBlockhash
      : readRecentBlockhashFromTransaction(transaction);
    if (!recentBlockhash) continue;

    const validity = await readSolanaRpc<{ value: boolean }>("isBlockhashValid", [
      recentBlockhash,
      { commitment: "confirmed" }
    ]);
    if (validity.value !== false) continue;

    await updateGasTankOperationAttempt(db, {
      workspaceId,
      operationId: operation.id,
      status: "cancelled",
      transactionSignature: signature,
      feeLamports: operation.feeLamports,
      failureCode: "recent_blockhash_expired",
      expectedUpdatedAt: operation.updatedAt
    });
  }
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ workspaceId: string }> }
): Promise<Response> {
  const { workspaceId } = await params;
  const context = await contributorContext(workspaceId);
  if ("response" in context) return context.response!;
  try {
    await reconcilePreparedConfidentialSetupOperations(
      context.db, workspaceId, context.session.walletAddress
    );
    const policy = await currentPolicy(workspaceId, context);
    if ("response" in policy) return policy.response!;
    if (BigInt(policy.gasTank.balanceLamports) < MAX_CONFIDENTIAL_ACCOUNT_SETUP_RENT_LAMPORTS) {
      return NextResponse.json({ error: "gas_tank_insufficient_balance" }, { status: 409 });
    }
    return NextResponse.json({
      feePayerAddress: policy.feePayerAddress,
      mintAddress: policy.config.PAYLORE_WRAPPED_USDC_MINT
    }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    console.error(JSON.stringify({ event: "confidential_setup_sponsorship_policy_failed" }));
    return NextResponse.json({ error: "confidential_setup_sponsorship_unavailable" }, { status: 503 });
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> }
): Promise<Response> {
  let operation: { id: string; updatedAt: Date } | null = null;
  try {
    assertSameOrigin(request);
    const contentLength = request.headers.get("content-length");
    if (contentLength && /^\d+$/.test(contentLength) && Number(contentLength) > MAX_REQUEST_BYTES) {
      return NextResponse.json({ error: "request_too_large" }, { status: 413 });
    }
    const text = await request.text();
    if (Buffer.byteLength(text) > MAX_REQUEST_BYTES) {
      return NextResponse.json({ error: "request_too_large" }, { status: 413 });
    }
    let body: unknown;
    try { body = JSON.parse(text); } catch {
      return NextResponse.json({ error: "invalid_sponsorship_request" }, { status: 400 });
    }
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_sponsorship_request" }, { status: 400 });
    }

    const { workspaceId } = await params;
    const context = await contributorContext(workspaceId);
    if ("response" in context) return context.response!;
    const policy = await currentPolicy(workspaceId, context, true);
    if ("response" in policy) return policy.response!;
    await reconcilePreparedConfidentialSetupOperations(
      context.db, workspaceId, context.session.walletAddress
    );

    const since = new Date(Date.now() - idempotencyWindowMs);
    const usage = await getWorkspaceGasTankSponsorshipUsage(context.db, workspaceId, since);
    const inspected = await inspectSponsoredConfidentialSetupTransaction({
      transactionBase64: parsed.data.transactionBase64,
      ownerAddress: context.session.walletAddress,
      mintAddress: policy.config.PAYLORE_WRAPPED_USDC_MINT!,
      tokenAccountAddress: policy.tokenAccountAddress,
      token2022ProgramAddress: TOKEN_2022_PROGRAM_ADDRESS,
      gasTankAddress: policy.gasTank.address,
      balanceLamports: policy.gasTank.balanceLamports,
      dailyBookedFeesLamports: usage.feeLamports,
      dailyOperationCount: usage.operationCount,
      deferCostCheck: true
    });
    const digest = createHash("sha256")
      .update(workspaceId)
      .update("\0")
      .update(context.session.walletAddress)
      .update("\0")
      .update(inspected.messageBytes)
      .digest("hex");
    const idempotencyKey = `confidential-account-setup:${digest}`;
    const existing = await getWorkspaceGasTankOperationByIdempotencyKey(
      context.db, workspaceId, idempotencyKey
    );
    if (existing?.requestDigest && existing.requestDigest !== digest) {
      return NextResponse.json({ error: "confidential_setup_sponsorship_conflict" }, { status: 409 });
    }
    if (
      existing?.status === "cancelled" &&
      existing.failureCode === "recent_blockhash_expired"
    ) {
      return NextResponse.json({
        error: "confidential_setup_blockhash_expired",
        action: "prepare_fresh_transaction"
      }, { status: 409 });
    }
    if (existing?.status === "finalized" && existing.transactionSignature) {
      return NextResponse.json({ signature: existing.transactionSignature, status: "finalized" });
    }
    if (
      existing?.status === "failed" &&
      existing.failureCode === "finalized_chain_failure"
    ) {
      return NextResponse.json({ error: "confidential_setup_transaction_failed" }, { status: 409 });
    }
    if (existing?.status === "prepared" && existing.transactionSignature) {
      const statuses = await readSolanaRpc<{ value: Array<{ confirmationStatus?: string | null; err?: unknown } | null> }>(
        "getSignatureStatuses", [[existing.transactionSignature], { searchTransactionHistory: true }]
      );
      const status = statuses.value[0];
      if (status?.confirmationStatus === "finalized" && status.err === null) {
        await updateGasTankOperationAttempt(context.db, {
          workspaceId, operationId: existing.id, status: "finalized",
          transactionSignature: existing.transactionSignature,
          feeLamports: existing.feeLamports,
          expectedUpdatedAt: existing.updatedAt
        });
        return NextResponse.json({ signature: existing.transactionSignature, status: "finalized" });
      }
      if (status?.confirmationStatus === "finalized" && status.err !== null) {
        const failed = await updateGasTankOperationAttempt(context.db, {
          workspaceId, operationId: existing.id, status: "failed",
          transactionSignature: existing.transactionSignature,
          feeLamports: existing.feeLamports,
          failureCode: "finalized_chain_failure",
          expectedUpdatedAt: existing.updatedAt
        });
        return failed
          ? NextResponse.json({ error: "confidential_setup_transaction_failed" }, { status: 409 })
          : NextResponse.json({ signature: existing.transactionSignature, status: "pending", error: "confidential_setup_sponsorship_pending" }, { status: 202 });
      }
      if (status === null) {
        const transaction = await readSolanaRpc<unknown>("getTransaction", [
          existing.transactionSignature,
          { commitment: "finalized", maxSupportedTransactionVersion: 0 }
        ]);
        const finalResult = readFinalizedTransactionError(transaction);
        if (finalResult.found) {
          const updated = await updateGasTankOperationAttempt(context.db, {
            workspaceId,
            operationId: existing.id,
            status: finalResult.error === null ? "finalized" : "failed",
            transactionSignature: existing.transactionSignature,
            feeLamports: existing.feeLamports,
            ...(finalResult.error === null ? {} : { failureCode: "finalized_chain_failure" }),
            expectedUpdatedAt: existing.updatedAt
          });
          if (updated && finalResult.error === null) {
            return NextResponse.json({ signature: existing.transactionSignature, status: "finalized" });
          }
          if (updated && finalResult.error !== null) {
            return NextResponse.json({ error: "confidential_setup_transaction_failed" }, { status: 409 });
          }
        }
        if (transaction === null) {
          const validity = await readSolanaRpc<{ value: boolean }>("isBlockhashValid", [
            inspected.recentBlockhash,
            { commitment: "confirmed" }
          ]);
          if (validity.value === false) {
            const cancelled = await updateGasTankOperationAttempt(context.db, {
              workspaceId,
              operationId: existing.id,
              status: "cancelled",
              transactionSignature: existing.transactionSignature,
              feeLamports: existing.feeLamports,
              failureCode: "recent_blockhash_expired",
              expectedUpdatedAt: existing.updatedAt
            });
            return cancelled
              ? NextResponse.json({
                  error: "confidential_setup_blockhash_expired",
                  action: "prepare_fresh_transaction"
                }, { status: 409 })
              : NextResponse.json({
                  signature: existing.transactionSignature,
                  status: "pending",
                  error: "confidential_setup_sponsorship_pending"
                }, { status: 202 });
          }
        }
      }
      return NextResponse.json({
        signature: existing.transactionSignature,
        status: "pending",
        error: "confidential_setup_sponsorship_pending"
      }, { status: 202 });
    }
    if (existing?.status === "preparing") {
      return NextResponse.json({ error: "confidential_setup_sponsorship_pending" }, { status: 409 });
    }
    if (policy.accountReady) {
      return NextResponse.json({ error: "confidential_account_already_ready" }, { status: 409 });
    }
    if (inspected.feeLamports === null) {
      return NextResponse.json({ error: "sponsored_fee_unavailable" }, { status: 409 });
    }
    const feeLamports = inspected.feeLamports;
    assertSponsoredCost({
      transactionBytes: inspected.transactionBytes,
      feeLamports,
      balanceLamports: BigInt(policy.gasTank.balanceLamports),
      dailyBookedFeesLamports: usage.feeLamports,
      dailyOperationCount: usage.operationCount
    });

    const reservedRentLamports = String(inspected.reservedRentLamports);
    const started = await beginGasTankOperationAttempt(context.db, {
      workspaceId,
      idempotencyKey,
      operationType: "confidential_account_setup",
      requestDigest: digest,
      reservedFeeLamports: String(feeLamports),
      availableBalanceLamports: policy.gasTank.balanceLamports,
      maxDailyFeeLamports: String(MAX_DAILY_SPONSORED_FEE_LAMPORTS),
      maxDailyOperations: MAX_DAILY_SPONSORED_OPERATIONS,
      since,
      operationData: {
        ownerAddress: context.session.walletAddress,
        mintAddress: policy.config.PAYLORE_WRAPPED_USDC_MINT,
        tokenAccountAddress: policy.tokenAccountAddress,
        recentBlockhash: inspected.recentBlockhash,
        reservedRentLamports
      }
    });
    if (started.status !== "started" || !started.operation) {
      const status = started.status === "gas_tank_insufficient_balance" ? 409 : 429;
      return NextResponse.json({
        error: started.status === "gas_tank_insufficient_balance"
          ? "gas_tank_insufficient_balance"
          : started.status === "gas_tank_daily_sponsorship_limit"
            ? "gas_tank_daily_sponsorship_limit"
            : "confidential_setup_sponsorship_conflict"
      }, { status });
    }
    operation = { id: started.operation.id, updatedAt: started.operation.updatedAt };
    const submitted = await withWorkspaceGasTankKey(
      context.db,
      workspaceId,
      (privateKey) => submitSponsoredConfidentialSetupTransaction({
        transaction: inspected.transaction,
        gasTankAddress: policy.gasTank.address,
        gasTankPrivateKey: privateKey,
        feeLamports
      })
    );
    const persisted = await updateGasTankOperationAttempt(context.db, {
      workspaceId,
      operationId: operation.id,
      status: "prepared",
      transactionSignature: submitted.signature,
      feeLamports: submitted.feeLamports,
      operationData: {
        ownerAddress: context.session.walletAddress,
        mintAddress: policy.config.PAYLORE_WRAPPED_USDC_MINT,
        tokenAccountAddress: policy.tokenAccountAddress,
        recentBlockhash: inspected.recentBlockhash,
        reservedRentLamports
      },
      expectedUpdatedAt: operation.updatedAt
    });
    if (!persisted) {
      return NextResponse.json({
        signature: submitted.signature,
        status: "pending",
        error: "confidential_setup_sponsorship_pending"
      }, { status: 202 });
    }
    return NextResponse.json({ signature: submitted.signature, status: "submitted" });
  } catch (error) {
    if (operation) {
      await updateGasTankOperationAttempt(
        getDatabase(),
        {
          workspaceId: (await params).workspaceId,
          operationId: operation.id,
          status: "failed",
          failureCode: error instanceof GasTankSponsorshipPolicyError ? error.code : "confidential_setup_sponsorship_failed",
          expectedUpdatedAt: operation.updatedAt
        }
      ).catch(() => undefined);
    }
    if (error instanceof RequestSecurityError) {
      return NextResponse.json({ error: "request_not_allowed" }, { status: 403 });
    }
    if (error instanceof GasTankSponsorshipPolicyError) {
      const status = error.code === "gas_tank_insufficient_balance" ? 409
        : error.code.includes("owner_signature") || error.code.includes("owner_signature_invalid") ? 403
        : error.code.includes("encoding_invalid") ? 400 : 409;
      return NextResponse.json({
        error: error.code === "gas_tank_insufficient_balance"
          ? "gas_tank_insufficient_balance"
          : "confidential_setup_sponsorship_unavailable"
      }, { status });
    }
    console.error(JSON.stringify({ event: "confidential_setup_sponsorship_failed" }));
    return NextResponse.json({ error: "confidential_setup_sponsorship_unavailable" }, { status: 503 });
  }
}
