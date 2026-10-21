import { createHash } from "node:crypto";
import {
  applyVerifiedSubscriptionPayment,
  claimDueSolanaWebhookEvents,
  createWorkspaceNotificationForFinanceMembers,
  createDatabase,
  getSubscriptionPaymentAttemptBySignature,
  getPayrollAllocationForChainReconciliation,
  getPayrollAllocationsForChainReconciliationByClaimIds,
  recordPayrollClaimSubmission,
  recordVerifiedPayrollRecoveryEvent,
  updateSubscriptionPaymentAttemptStatus,
  updateSolanaWebhookEventState
} from "../../packages/database/src/index";
import { parseConfig, parsePayloreConfig } from "../../apps/web/src/server/config";
import { readSolanaRpcWithProviders } from "../../apps/web/src/server/solana/rpc-core";
import { transactionInvokesProgram } from "../../apps/web/src/server/solana/transaction-program-invocation";
import { isExactSubscriptionPaymentTransaction } from "../../apps/web/src/server/solana/subscription-payment-chain-check";

export const config = {
  schedule: "* * * * *"
};

type FinalizedTransaction = {
  slot: number;
  meta: { err: unknown } | null;
} | null;

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function decodeBase58(value: string): Uint8Array | null {
  let number = 0n;
  for (const character of value) {
    const digit = BASE58_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    number = number * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (number > 0n) {
    bytes.unshift(Number(number & 0xffn));
    number >>= 8n;
  }
  for (const character of value) {
    if (character !== "1") break;
    bytes.unshift(0);
  }
  return Uint8Array.from(bytes);
}

function configuredRpc() {
  const config = parsePayloreConfig(process.env);
  const providers = [{
    name: config.PAYLORE_RPC_PRIMARY_PROVIDER,
    url: config.PAYLORE_RPC_PRIMARY_URL,
    apiKey: config.PAYLORE_RPC_PRIMARY_API_KEY
  }];
  if (
    config.PAYLORE_RPC_SECONDARY_URL &&
    config.PAYLORE_RPC_SECONDARY_PROVIDER
  ) {
    providers.push({
      name: config.PAYLORE_RPC_SECONDARY_PROVIDER,
      url: config.PAYLORE_RPC_SECONDARY_URL,
      apiKey: config.PAYLORE_RPC_SECONDARY_API_KEY
    });
  }
  return {
    providers,
    payrollProgramId: config.PAYLORE_PAYROLL_PROGRAM_ID
  };
}

async function reconcileEvent(
  db: ReturnType<typeof createDatabase>["db"],
  event: Awaited<ReturnType<typeof claimDueSolanaWebhookEvents>>[number],
  providers: ReturnType<typeof configuredRpc>["providers"],
  payrollProgramId: string | undefined,
  now: Date
) {
  const deadLetter = event.attempts >= 8;
  const retryAt = new Date(
    now.getTime() +
      Math.min(60_000 * 2 ** Math.max(event.attempts - 1, 0), 3_600_000)
  );
  const retry = async (errorCode: string) =>
    updateSolanaWebhookEventState(db, {
      id: event.id,
      status: deadLetter ? "dead_letter" : "retry_pending",
      nextAttemptAt: deadLetter ? null : retryAt,
      errorCode,
      processedAt: deadLetter ? now : null,
      now
    });

  if (!event.transactionSignature) {
    await retry("missing_transaction_signature");
    return deadLetter ? "dead_letter" : "retry_pending";
  }

  const transaction = await readSolanaRpcWithProviders<FinalizedTransaction>(
    "getTransaction",
    [
      event.transactionSignature,
      {
        commitment: "finalized",
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0
      }
    ],
    providers
  );
  if (!transaction) {
    await retry("transaction_not_finalized");
    return deadLetter ? "dead_letter" : "retry_pending";
  }
  if (
    !Number.isSafeInteger(transaction.slot) ||
    (event.transactionSlot !== null &&
      String(transaction.slot) !== event.transactionSlot)
  ) {
    await updateSolanaWebhookEventState(db, {
      id: event.id,
      status: "dead_letter",
      errorCode: "transaction_slot_mismatch",
      processedAt: now,
      now
    });
    return "dead_letter";
  }
  if (!transaction.meta) {
    await retry("transaction_metadata_unavailable");
    return deadLetter ? "dead_letter" : "retry_pending";
  }
  if (transaction.meta.err !== null) {
    const failedAttempt = await getSubscriptionPaymentAttemptBySignature(
      db,
      event.transactionSignature
    );
    if (failedAttempt) {
      await updateSubscriptionPaymentAttemptStatus(db, {
        attemptId: failedAttempt.id,
        signature: event.transactionSignature,
        status: "failed",
        now
      });
    }
    await updateSolanaWebhookEventState(db, {
      id: event.id,
      status: "failed",
      errorCode: "transaction_failed",
      processedAt: now,
      now
    });
    return "failed";
  }
  const paymentAttempt = await getSubscriptionPaymentAttemptBySignature(
    db,
    event.transactionSignature
  );
  if (paymentAttempt) {
    const exactPayment = isExactSubscriptionPaymentTransaction(transaction, {
      signature: event.transactionSignature,
      payerAddress: paymentAttempt.payerWalletAddress,
      recipient: paymentAttempt.recipient,
      mint: paymentAttempt.mint,
      amountBaseUnits: paymentAttempt.amountBaseUnits
    });
    if (!exactPayment) {
      await updateSubscriptionPaymentAttemptStatus(db, {
        attemptId: paymentAttempt.id,
        signature: event.transactionSignature,
        status: "failed",
        now
      });
      await updateSolanaWebhookEventState(db, {
        id: event.id,
        status: "failed",
        errorCode: "subscription_payment_intent_mismatch",
        processedAt: now,
        now
      });
      return "failed";
    }

    const verified = await applyVerifiedSubscriptionPayment(db, {
      workspaceId: paymentAttempt.workspaceId,
      userId: paymentAttempt.userId,
      signature: event.transactionSignature,
      mint: paymentAttempt.mint,
      recipient: paymentAttempt.recipient,
      amountBaseUnits: paymentAttempt.amountBaseUnits,
      now
    });
    await updateSubscriptionPaymentAttemptStatus(db, {
      attemptId: paymentAttempt.id,
      signature: event.transactionSignature,
      status: "confirmed",
      now
    });
    await createWorkspaceNotificationForFinanceMembers(db, {
      workspaceId: paymentAttempt.workspaceId,
      eventKey: "subscription-payment:" + event.transactionSignature,
      category: "Workspace & Billing",
      title: "Subscription payment confirmed",
      body: "A finalized USDC payment activated or renewed this workspace subscription.",
      destination: "/workspace/" + paymentAttempt.workspaceId + "/billing"
    });
    await updateSolanaWebhookEventState(db, {
      id: event.id,
      status: "finalized",
      finalizedAt: now,
      processedAt: now,
      now
    });
    return verified.duplicate ? "finalized" : "finalized";
  }

  if (!payrollProgramId) {
    await retry("payroll_program_not_configured");
    return deadLetter ? "dead_letter" : "retry_pending";
  }
  if (!transactionInvokesProgram(transaction, payrollProgramId)) {
    await updateSolanaWebhookEventState(db, {
      id: event.id,
      status: "dead_letter",
      errorCode: "canonical_program_not_invoked",
      processedAt: now,
      now
    });
    return "dead_letter";
  }

  const parsed = transaction as unknown as {
    transaction?: { message?: { instructions?: Array<Record<string, unknown>> } };
  };
  const instructions = parsed.transaction?.message?.instructions ?? [];
  const createClaimDiscriminator = createHash("sha256")
    .update("global:create_claim")
    .digest()
    .subarray(0, 8);
  const transactionBody = transaction as unknown as {
    transaction?: {
      signatures?: unknown;
      message?: { accountKeys?: unknown };
    };
  };
  const signatures = transactionBody.transaction?.signatures;
  const accountKeys = transactionBody.transaction?.message?.accountKeys;
  const authoritySigned = Array.isArray(accountKeys) && accountKeys.some((entry) =>
    entry && typeof entry === "object" &&
    "pubkey" in entry && entry.pubkey === event.sourceAddress &&
    "signer" in entry && entry.signer === true
  );
  const claimInstructions: Array<{
    claimId: string;
    claimAddress: string;
    contributorAddress: string;
    commitment: string;
  }> = [];
  for (const instruction of instructions) {
    if (instruction.programId !== payrollProgramId ||
        typeof instruction.data !== "string" ||
        !Array.isArray(instruction.accounts)) continue;
    const data = decodeBase58(instruction.data);
    if (!data || data.length !== 72 ||
        !Buffer.from(data.subarray(0, 8)).equals(createClaimDiscriminator)) continue;
    const accounts = instruction.accounts;
    if (accounts.length !== 5 ||
        accounts.some((account) => typeof account !== "string")) continue;
    claimInstructions.push({
      claimId: Buffer.from(data.subarray(8, 40)).toString("hex"),
      commitment: Buffer.from(data.subarray(40, 72)).toString("hex"),
      contributorAddress: accounts[1] as string,
      claimAddress: accounts[3] as string
    });
  }
  if (claimInstructions.length > 0) {
    const signatureMatches = Array.isArray(signatures) &&
      signatures.includes(event.transactionSignature);
    if (!signatureMatches || !authoritySigned) {
      await updateSolanaWebhookEventState(db, {
        id: event.id,
        status: "dead_letter",
        errorCode: "payroll_claim_authority_not_verified",
        processedAt: now,
        now
      });
      return "dead_letter";
    }
    const uniqueClaimIds = claimInstructions.map((claim) => claim.claimId);
    if (new Set(uniqueClaimIds).size !== uniqueClaimIds.length) {
      await updateSolanaWebhookEventState(db, {
        id: event.id,
        status: "dead_letter",
        errorCode: "duplicate_claim_instruction",
        processedAt: now,
        now
      });
      return "dead_letter";
    }
    const allocations = await getPayrollAllocationsForChainReconciliationByClaimIds(
      db,
      uniqueClaimIds
    );
    if (allocations.length !== claimInstructions.length) {
      await retry("payroll_claim_allocation_not_mapped");
      return deadLetter ? "dead_letter" : "retry_pending";
    }
    const byClaimId = new Map(allocations.map((allocation) => [allocation.claimId, allocation]));
    const first = allocations[0];
    const submittedClaims: Array<{ claimId: string; claimAddress: string }> = [];
    for (const claim of claimInstructions) {
      const allocation = byClaimId.get(claim.claimId);
      if (!allocation ||
          allocation.workspaceId !== first.workspaceId ||
          allocation.runId !== first.runId ||
          allocation.contributorWalletAddress !== claim.contributorAddress ||
          allocation.allocationCommitment !== first.allocationCommitment ||
          claim.commitment !== first.allocationCommitment ||
          (allocation.claimAddress !== null && allocation.claimAddress !== claim.claimAddress)) {
        await updateSolanaWebhookEventState(db, {
          id: event.id,
          status: "dead_letter",
          errorCode: "payroll_claim_allocation_mismatch",
          processedAt: now,
          now
        });
        return "dead_letter";
      }
      submittedClaims.push({ claimId: claim.claimId, claimAddress: claim.claimAddress });
    }
    const result = await recordPayrollClaimSubmission(db, {
      workspaceId: first.workspaceId,
      runId: first.runId,
      signature: event.transactionSignature,
      claims: submittedClaims,
      now
    });
    if (result.status !== "committed" && result.status !== "submitting") {
      await retry("payroll_claim_state_conflict");
      return deadLetter ? "dead_letter" : "retry_pending";
    }
    await updateSolanaWebhookEventState(db, {
      id: event.id,
      status: "finalized",
      finalizedAt: now,
      processedAt: now,
      now
    });
    return "finalized";
  }

  const recoveryDiscriminator = createHash("sha256")
    .update("global:recover_claim")
    .digest()
    .subarray(0, 8);
  let claimAddress: string | null = null;
  for (const instruction of instructions) {
    if (instruction.programId !== payrollProgramId ||
        typeof instruction.data !== "string" ||
        !Array.isArray(instruction.accounts)) continue;
    const data = decodeBase58(instruction.data);
    if (!data || data.length !== 40 ||
        !Buffer.from(data.subarray(0, 8)).equals(recoveryDiscriminator) ||
        data.subarray(8).every((byte) => byte === 0)) continue;
    const candidate = instruction.accounts[3];
    if (typeof candidate === "string") {
      claimAddress = candidate;
      break;
    }
  }
  if (!claimAddress) {
    await retry("payroll_event_not_supported_for_reconciliation");
    return deadLetter ? "dead_letter" : "retry_pending";
  }

  const allocation = await getPayrollAllocationForChainReconciliation(db, claimAddress);
  if (!allocation) {
    await retry("recovery_claim_not_mapped");
    return deadLetter ? "dead_letter" : "retry_pending";
  }
  const recovery = await recordVerifiedPayrollRecoveryEvent(db, {
    workspaceId: allocation.workspaceId,
    runId: allocation.runId,
    allocationId: allocation.allocationId,
    signature: event.transactionSignature,
    claimAddress,
    now
  });
  if (recovery.status === "conflict" || recovery.status === "not_found") {
    await retry("recovery_claim_state_conflict");
    return deadLetter ? "dead_letter" : "retry_pending";
  }

  await updateSolanaWebhookEventState(db, {
    id: event.id,
    status: "finalized",
    finalizedAt: now,
    processedAt: now,
    now
  });
  return "finalized";
}

export default async function processSolanaWebhooks() {
  const appConfig = parseConfig(process.env);
  const { providers, payrollProgramId } = configuredRpc();
  const { db, client } = createDatabase(appConfig.DATABASE_URL);
  try {
    const events = await claimDueSolanaWebhookEvents(db, {
      limit: 5,
      leaseMilliseconds: 60_000
    });
    const results = await Promise.allSettled(
      events.map((event) =>
        reconcileEvent(db, event, providers, payrollProgramId, new Date())
      )
    );
    const failures = results.filter((result) => result.status === "rejected");
    console.log(JSON.stringify({
      event: "solana_webhook_reconciliation_completed",
      claimed: events.length,
      finalized: results.filter(
        (result) =>
          result.status === "fulfilled" && result.value === "finalized"
      ).length,
      failed: results.filter(
        (result) =>
          result.status === "fulfilled" && result.value === "failed"
      ).length,
      retried: results.filter(
        (result) =>
          result.status === "fulfilled" && result.value === "retry_pending"
      ).length,
      deadLettered: results.filter(
        (result) =>
          result.status === "fulfilled" && result.value === "dead_letter"
      ).length,
      processingErrors: failures.length
    }));
    if (failures.length > 0) {
      throw new Error("One or more webhook events could not be reconciled.");
    }
  } finally {
    await client.end({ timeout: 5 });
  }
}
