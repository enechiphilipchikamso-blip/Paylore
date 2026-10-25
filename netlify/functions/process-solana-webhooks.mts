import { createHash } from "node:crypto";
import {
  applyVerifiedSubscriptionPayment,
  claimDueSolanaWebhookEvents,
  getCanonicalReconciliationCursor,
  listCanonicalReconciliationCursors,
  listHeliusMonitoredAddresses,
  persistCanonicalReconciliationScanPage,
  listFinalizedLedgerWorkspaceIdsForSignature,
  recordVerifiedPayrollClaimFinalizationEvent,
  createWorkspaceNotificationForFinanceMembers,
  createDatabase,
  getSubscriptionPaymentAttemptBySignature,
  getWorkspaceGasTankByAddress,
  getWorkspaceReserve,
  getPayrollClaimEscrow,
  getPayrollClaimCreationEvidence,
  recordVerifiedGasTankFundingEvent,
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
import {
  findFinalizeClaimedInstruction,
  findRecoverClaimInstruction,
  getFinalizedLedgerReconciliationDisposition,
  getWebhookTransactionBindingError
} from "../../apps/web/src/server/solana/webhook-policy";
import {
  derivePayrollReserveTokenAccount,
  verifyPayrollClaimTransaction,
  verifyPayrollRecoveryTransaction
} from "../../apps/web/src/server/solana/payroll-program-verification";
import {
  findSupportedPayrollEvent,
  findSystemTransferDestination,
  scanCanonicalSignaturePage,
  type CanonicalScanEvent,
  type CanonicalSignatureInfo,
  type CanonicalTransactionLike
} from "../../apps/web/src/server/solana/canonical-event-scanner";

export const config = {
  schedule: "* * * * *"
};

type FinalizedTransaction = {
  slot: number;
  meta: { err: unknown } | null;
  transaction?: {
    signatures?: unknown;
    message?: { accountKeys?: unknown; instructions?: Array<Record<string, unknown>> };
  };
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
    payrollProgramId: config.PAYLORE_PAYROLL_PROGRAM_ID,
    wrappedMint: config.PAYLORE_WRAPPED_USDC_MINT,
    subscriptionRecipient: config.PAYLORE_SUBSCRIPTION_RECIPIENT
  };
}

async function reconcileEvent(
  db: ReturnType<typeof createDatabase>["db"],
  event: Awaited<ReturnType<typeof claimDueSolanaWebhookEvents>>[number],
  providers: ReturnType<typeof configuredRpc>["providers"],
  payrollProgramId: string | undefined,
  wrappedMint: string | undefined,
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
  const bindingError = getWebhookTransactionBindingError({
    requestedSignature: event.transactionSignature,
    expectedSlot: event.transactionSlot,
    accountAddress: event.accountAddress,
    transaction
  });
  if (bindingError) {
    await updateSolanaWebhookEventState(db, {
      id: event.id,
      status: "dead_letter",
      errorCode: bindingError,
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

  const existingLedgerWorkspaces = await listFinalizedLedgerWorkspaceIdsForSignature(
    db,
    event.transactionSignature
  );
  const existingLedgerDisposition = getFinalizedLedgerReconciliationDisposition(
    existingLedgerWorkspaces.map((row) => row.workspaceId)
  );
  if (existingLedgerDisposition === "ambiguous_workspace") {
    await updateSolanaWebhookEventState(db, {
      id: event.id,
      status: "dead_letter",
      errorCode: "ledger_signature_workspace_conflict",
      processedAt: now,
      now
    });
    return "dead_letter";
  }
  if (existingLedgerDisposition === "reconciled") {
    await updateSolanaWebhookEventState(db, {
      id: event.id,
      status: "finalized",
      finalizedAt: now,
      processedAt: now,
      now
    });
    return "finalized";
  }

  const parsedTransaction = transaction as unknown as {
    transaction?: { signatures?: unknown; message?: { accountKeys?: unknown; instructions?: Array<Record<string, unknown>> } };
  };
  const txSignatures = parsedTransaction.transaction?.signatures;
  const txKeys = parsedTransaction.transaction?.message?.accountKeys;
  const txInstructions = parsedTransaction.transaction?.message?.instructions ?? [];
  const hasSignature = Array.isArray(txSignatures) && txSignatures.includes(event.transactionSignature);
  const signerAddresses = Array.isArray(txKeys) ? txKeys.flatMap((entry) =>
    entry && typeof entry === "object" && "pubkey" in entry &&
    typeof entry.pubkey === "string" && "signer" in entry && entry.signer === true
      ? [entry.pubkey] : []
  ) : [];
  if (hasSignature) {
    for (const instruction of txInstructions) {
      if (instruction.program !== "system" ||
          instruction.programId !== "11111111111111111111111111111111" ||
          !instruction.parsed || typeof instruction.parsed !== "object") continue;
      const parsed = instruction.parsed as Record<string, unknown>;
      if (parsed.type !== "transfer" || !parsed.info || typeof parsed.info !== "object") continue;
      const info = parsed.info as Record<string, unknown>;
      if (typeof info.source !== "string" || typeof info.destination !== "string" ||
          (typeof info.lamports !== "string" && typeof info.lamports !== "number") ||
          !signerAddresses.includes(info.source)) continue;
      let amount: bigint;
      try {
        if (typeof info.lamports === "number" && !Number.isSafeInteger(info.lamports)) continue;
        amount = BigInt(info.lamports);
      } catch { continue; }
      if (amount <= 0n || amount >= (1n << 64n)) continue;
      const gasTank = await getWorkspaceGasTankByAddress(db, info.destination);
      if (!gasTank) continue;
      const balance = await readSolanaRpcWithProviders<{ value: number }>(
        "getBalance", [gasTank.address, { commitment: "finalized" }], providers
      );
      if (!balance || !Number.isSafeInteger(balance.value) || balance.value < 0) {
        await retry("gas_tank_balance_not_reconciled");
        return deadLetter ? "dead_letter" : "retry_pending";
      }
      const funding = await recordVerifiedGasTankFundingEvent(db, {
        workspaceId: gasTank.workspaceId, destination: gasTank.address,
        source: info.source, signature: event.transactionSignature,
        amountLamports: amount.toString(), confirmedBalanceLamports: String(balance.value), now
      });
      if (funding.status === "not_found") {
        await retry("gas_tank_mapping_changed_during_reconciliation");
        return deadLetter ? "dead_letter" : "retry_pending";
      }
      await updateSolanaWebhookEventState(db, {
        id: event.id, status: "finalized", finalizedAt: now, processedAt: now, now
      });
      return "finalized";
    }
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
  const signerAddresses = Array.isArray(accountKeys)
    ? accountKeys.flatMap((entry) =>
        entry && typeof entry === "object" &&
        "pubkey" in entry && typeof entry.pubkey === "string" &&
        "signer" in entry && entry.signer === true
          ? [entry.pubkey]
          : []
      )
    : [];
  const claimInstructions: Array<{
    claimId: string;
    claimAddress: string;
    contributorAddress: string;
    authorityAddress: string;
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
      authorityAddress: accounts[0] as string,
      contributorAddress: accounts[1] as string,
      claimAddress: accounts[3] as string
    });
  }
  if (claimInstructions.length > 0) {
    const signatureMatches = Array.isArray(signatures) &&
      signatures.includes(event.transactionSignature);
    if (!signatureMatches || claimInstructions.some((claim) =>
      !signerAddresses.includes(claim.authorityAddress)
    )) {
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
    if (!first || !first.allocationCommitment ||
        claimInstructions.some((claim) =>
          claim.authorityAddress !== claimInstructions[0].authorityAddress
        )) {
      await updateSolanaWebhookEventState(db, {
        id: event.id,
        status: "dead_letter",
        errorCode: "payroll_claim_commitment_or_authority_missing",
        processedAt: now,
        now
      });
      return "dead_letter";
    }
    try {
      await verifyPayrollClaimTransaction({
        signature: event.transactionSignature,
        authorityAddress: claimInstructions[0].authorityAddress,
        workspaceId: first.workspaceId,
        allocationCommitment: first.allocationCommitment,
        claims: claimInstructions.map((claim) => ({
          claimId: claim.claimId,
          claimAddress: claim.claimAddress,
          contributorAddress: claim.contributorAddress
        }))
      });
    } catch {
      await retry("payroll_claim_chain_state_not_reconciled");
      return deadLetter ? "dead_letter" : "retry_pending";
    }
    const result = await recordPayrollClaimSubmission(db, {
      workspaceId: first.workspaceId,
      runId: first.runId,
      signature: event.transactionSignature,
      programId: payrollProgramId,
      authorityAddress: claimInstructions[0].authorityAddress,
      claims: submittedClaims,
      now
    });
    if (
      result.status !== "committed" &&
      result.status !== "submitting" &&
      result.status !== "duplicate"
    ) {
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

  const finalizationInstruction = findFinalizeClaimedInstruction({
    transaction,
    payrollProgramId
  });
  if (finalizationInstruction.kind === "invalid") {
    await updateSolanaWebhookEventState(db, {
      id: event.id,
      status: "dead_letter",
      errorCode: finalizationInstruction.errorCode,
      processedAt: now,
      now
    });
    return "dead_letter";
  }
  if (finalizationInstruction.kind === "found") {
    const allocation = await getPayrollAllocationForChainReconciliation(
      db,
      finalizationInstruction.claimAddress
    );
    if (!allocation || !allocation.claimId || !allocation.transactionSignature ||
        !allocation.settlementSignature || !allocation.allocationCommitment ||
        allocation.allocationStatus !== "claimed") {
      await retry("claim_finalization_application_state_not_reconciled");
      return deadLetter ? "dead_letter" : "retry_pending";
    }
    const recorded = await recordVerifiedPayrollClaimFinalizationEvent(db, {
      workspaceId: allocation.workspaceId,
      runId: allocation.runId,
      allocationId: allocation.allocationId,
      claimAddress: finalizationInstruction.claimAddress,
      claimCreationSignature: allocation.transactionSignature,
      settlementSignature: allocation.settlementSignature,
      authorityAddress: finalizationInstruction.authorityAddress,
      signature: event.transactionSignature,
      now
    });
    if (recorded.status !== "finalized" && recorded.status !== "duplicate") {
      await retry("claim_finalization_settlement_ledger_not_reconciled");
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

  const recoveryMatch = findRecoverClaimInstruction({ transaction, payrollProgramId });
  if (recoveryMatch.kind === "invalid") {
    await updateSolanaWebhookEventState(db, {
      id: event.id, status: "dead_letter", errorCode: recoveryMatch.errorCode, processedAt: now, now
    });
    return "dead_letter";
  }
  if (recoveryMatch.kind !== "found") {
    await retry("payroll_event_not_supported_for_reconciliation");
    return deadLetter ? "dead_letter" : "retry_pending";
  }

  const allocation = await getPayrollAllocationForChainReconciliation(db, recoveryMatch.claimAddress);
  if (!allocation || !allocation.claimId || !allocation.claimAddress ||
      !allocation.allocationCommitment || !allocation.amountCommitment ||
      !allocation.contributorWalletAddress || !allocation.recoveryReason) {
    await retry("recovery_claim_not_mapped");
    return deadLetter ? "dead_letter" : "retry_pending";
  }
  const [escrow, reserve, evidence] = await Promise.all([
    getPayrollClaimEscrow(db, allocation.workspaceId, allocation.allocationId),
    getWorkspaceReserve(db, allocation.workspaceId),
    getPayrollClaimCreationEvidence(db, {
      workspaceId: allocation.workspaceId, runId: allocation.runId,
      claimId: allocation.claimId, claimAddress: recoveryMatch.claimAddress
    }).catch(() => null)
  ]);
  if (!escrow || !reserve || !evidence || !wrappedMint) {
    await retry("recovery_claim_application_state_unavailable");
    return deadLetter ? "dead_letter" : "retry_pending";
  }
  let expectedReserveToken: string;
  try {
    expectedReserveToken = await derivePayrollReserveTokenAccount(reserve.address, wrappedMint);
  } catch {
    await retry("recovery_reserve_token_account_unavailable");
    return deadLetter ? "dead_letter" : "retry_pending";
  }
  const expectedReasonCommitment = createHash("sha256")
    .update(`paylore:recovery:v1:${JSON.stringify({
      reason: allocation.recoveryReason,
      note: allocation.recoveryReasonNote ?? null
    })}`)
    .digest("hex");
  if (evidence.programId !== payrollProgramId ||
      evidence.allocationCommitment !== allocation.allocationCommitment ||
      recoveryMatch.contributorAddress !== allocation.contributorWalletAddress ||
      recoveryMatch.claimAddress !== allocation.claimAddress ||
      recoveryMatch.reserveAuthorityAddress !== reserve.address ||
      recoveryMatch.reserveTokenAccount !== expectedReserveToken ||
      recoveryMatch.mint !== wrappedMint ||
      recoveryMatch.escrowTokenAccount !== escrow.tokenAccountAddress ||
      recoveryMatch.reasonCommitment !== expectedReasonCommitment) {
    await updateSolanaWebhookEventState(db, {
      id: event.id, status: "dead_letter",
      errorCode: "recovery_claim_application_binding_mismatch", processedAt: now, now
    });
    return "dead_letter";
  }
  try {
    await verifyPayrollRecoveryTransaction({
      signature: event.transactionSignature,
      authorityAddress: evidence.authorityAddress,
      reserveAuthorityAddress: reserve.address,
      workspaceId: allocation.workspaceId,
      contributorAddress: allocation.contributorWalletAddress,
      claimId: allocation.claimId,
      claimAddress: recoveryMatch.claimAddress,
      allocationCommitment: evidence.allocationCommitment,
      amountCommitment: allocation.amountCommitment,
      escrowTokenAccount: escrow.tokenAccountAddress,
      reserveTokenAccount: expectedReserveToken,
      mint: wrappedMint,
      recoveryReasonCommitment: recoveryMatch.reasonCommitment
    });
  } catch {
    await retry("recovery_claim_chain_state_not_reconciled");
    return deadLetter ? "dead_letter" : "retry_pending";
  }
  const recovery = await recordVerifiedPayrollRecoveryEvent(db, {
    workspaceId: allocation.workspaceId,
    runId: allocation.runId,
    allocationId: allocation.allocationId,
    signature: event.transactionSignature,
    claimAddress: recoveryMatch.claimAddress,
    now
  });
  if (recovery.status === "conflict" || recovery.status === "not_found") {
    await retry("recovery_claim_state_conflict");
    return deadLetter ? "dead_letter" : "retry_pending";
  }
  if (recovery.status !== "duplicate") {
    await createWorkspaceNotificationForFinanceMembers(db, {
      workspaceId: allocation.workspaceId,
      eventKey: "payroll-recovery:" + event.transactionSignature,
      category: "Recovery & Offboarding",
      title: "Payroll allocation recovered",
      body: "A finalized recovery transaction was reconciled with the allocation's on-chain state.",
      destination: "/workspace/" + allocation.workspaceId + "/payroll/" + allocation.runId,
      now
    });
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


function signedSystemTransferSource(
  transaction: CanonicalTransactionLike,
  destination: string
): string | null {
  const message = transaction.transaction?.message;
  const instructions = Array.isArray(message?.instructions) ? message.instructions : [];
  const keys = Array.isArray(message?.accountKeys) ? message.accountKeys : [];
  const signers = keys.flatMap((entry) => {
    if (entry && typeof entry === "object" &&
        "pubkey" in entry && typeof entry.pubkey === "string" &&
        "signer" in entry && entry.signer === true) return [entry.pubkey];
    return [];
  });
  const sources = new Set<string>();
  for (const instruction of instructions) {
    if (instruction.programId !== "11111111111111111111111111111111" ||
        (instruction.program !== undefined && instruction.program !== "system") ||
        !instruction.parsed || typeof instruction.parsed !== "object") continue;
    const parsed = instruction.parsed as Record<string, unknown>;
    if (parsed.type !== "transfer" || !parsed.info || typeof parsed.info !== "object") continue;
    const info = parsed.info as Record<string, unknown>;
    if (info.destination !== destination || typeof info.source !== "string" ||
        !signers.includes(info.source) ||
        (typeof info.lamports !== "string" && typeof info.lamports !== "number")) continue;
    try {
      if (typeof info.lamports === "number" && !Number.isSafeInteger(info.lamports)) continue;
      const amount = BigInt(info.lamports);
      if (amount <= 0n || amount >= (1n << 64n)) continue;
    } catch { continue; }
    sources.add(info.source);
  }
  return sources.size === 1 ? [...sources][0] : null;
}

async function discoverMissingCanonicalEvents(
  db: ReturnType<typeof createDatabase>["db"],
  providers: ReturnType<typeof configuredRpc>["providers"],
  payrollProgramId: string | undefined,
  subscriptionRecipient: string | undefined
): Promise<void> {
  const monitored = await listHeliusMonitoredAddresses(db);
  const watchedAddresses = [...new Set([
    ...monitored,
    ...(payrollProgramId ? [payrollProgramId] : []),
    ...(subscriptionRecipient ? [subscriptionRecipient] : [])
  ])].sort();
  if (watchedAddresses.length === 0) return;

  const cursors = await listCanonicalReconciliationCursors(db);
  const cursorByAddress = new Map(cursors.map((cursor) => [cursor.address, cursor]));
  const scanAddresses = watchedAddresses.sort((left, right) => {
    const leftTime = cursorByAddress.get(left)?.updatedAt?.getTime() ?? 0;
    const rightTime = cursorByAddress.get(right)?.updatedAt?.getTime() ?? 0;
    return leftTime - rightTime || left.localeCompare(right);
  }).slice(0, 8);

  for (const watchedAddress of scanAddresses) {
    try {
      const stored = await getCanonicalReconciliationCursor(db, watchedAddress);
      const page = await scanCanonicalSignaturePage({
        address: watchedAddress,
        cursor: stored,
        fetchSignatures: async (address, options) => {
          const raw = await readSolanaRpcWithProviders<unknown>(
            "getSignaturesForAddress",
            [address, {
              commitment: "finalized", limit: options.limit,
              ...(options.before ? { before: options.before } : {}),
              ...(options.until ? { until: options.until } : {})
            }],
            providers
          );
          if (!Array.isArray(raw) || raw.some((item) => !item || typeof item !== "object" ||
              typeof (item as Record<string, unknown>).signature !== "string" ||
              !Number.isSafeInteger((item as Record<string, unknown>).slot) ||
              Number((item as Record<string, unknown>).slot) < 0)) {
            throw new Error("Canonical signature listing returned an invalid page.");
          }
          return raw as CanonicalSignatureInfo[];
        },
        inspect: async (info, address) => {
          const attempt = await getSubscriptionPaymentAttemptBySignature(db, info.signature);
          if (attempt) {
            return {
              ready: true,
              event: {
                provider: "canonical-rpc-scanner" as const,
                providerEventId: info.signature,
                transactionSignature: info.signature,
                transactionSlot: String(info.slot),
                accountAddress: address,
                eventType: "subscription-payment-attempt",
                payload: { signature: info.signature, slot: info.slot, type: "subscription-payment-attempt", sourceAddress: address },
                status: "received" as const
              }
            };
          }

          const transaction = await readSolanaRpcWithProviders<FinalizedTransaction>(
            "getTransaction",
            [info.signature, { commitment: "finalized", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }],
            providers
          );
          if (!transaction) return { ready: false };
          const bindingError = getWebhookTransactionBindingError({
            requestedSignature: info.signature,
            expectedSlot: String(info.slot),
            accountAddress: address,
            transaction
          });
          if (bindingError) return { ready: false };

          const canonical = transaction as unknown as CanonicalTransactionLike;
          const payrollEvent = payrollProgramId
            ? findSupportedPayrollEvent(canonical, payrollProgramId)
            : null;
          const destination = findSystemTransferDestination(canonical);
          const gasTank = destination ? await getWorkspaceGasTankByAddress(db, destination) : null;
          const transferSource = destination && gasTank
            ? signedSystemTransferSource(canonical, destination)
            : null;
          const eventType = payrollEvent
            ? "payroll-" + payrollEvent
            : gasTank && transferSource ? "gas-tank-funding" : null;
          if (!eventType) return { ready: true, event: null };

          const event: CanonicalScanEvent = {
            provider: "canonical-rpc-scanner",
            providerEventId: info.signature,
            transactionSignature: info.signature,
            transactionSlot: String(info.slot),
            accountAddress: address,
            eventType,
            payload: {
              signature: info.signature, slot: info.slot, type: eventType,
              sourceAddress: transferSource ?? address
            },
            status: "received"
          };
          return { ready: true, event };
        }
      });
      if (!page) continue;
      const now = new Date();
      await persistCanonicalReconciliationScanPage(db, {
        ...page.cursor,
        events: page.events.map((event) => ({ ...event, receivedAt: now })),
        now
      });
    } catch {
      // Failed pages leave both the durable cursor and event queue untouched for the next scheduled run.
      continue;
    }
  }
}

export default async function processSolanaWebhooks() {
  const appConfig = parseConfig(process.env);
  const { providers, payrollProgramId, wrappedMint, subscriptionRecipient } = configuredRpc();
  const { db, client } = createDatabase(appConfig.DATABASE_URL);
  try {
    try {
      await discoverMissingCanonicalEvents(db, providers, payrollProgramId, subscriptionRecipient);
    } catch {
      console.error(JSON.stringify({ event: "canonical_event_scanner_deferred" }));
    }
    const events = await claimDueSolanaWebhookEvents(db, {
      limit: 5,
      leaseMilliseconds: 60_000
    });
    const results = await Promise.allSettled(
      events.map((event) =>
        reconcileEvent(db, event, providers, payrollProgramId, wrappedMint, new Date())
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
