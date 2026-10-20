import {
  claimDueSolanaWebhookEvents,
  createDatabase,
  updateSolanaWebhookEventState
} from "../../packages/database/src/index";
import { parseConfig, parsePayloreConfig } from "../../apps/web/src/server/config";
import { readSolanaRpcWithProviders } from "../../apps/web/src/server/solana/rpc-core";
import { transactionInvokesProgram } from "../../apps/web/src/server/solana/transaction-program-invocation";

export const config = {
  schedule: "* * * * *"
};

type FinalizedTransaction = {
  slot: number;
  meta: { err: unknown } | null;
} | null;

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
    await updateSolanaWebhookEventState(db, {
      id: event.id,
      status: "failed",
      errorCode: "transaction_failed",
      processedAt: now,
      now
    });
    return "failed";
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
