import { z } from "zod";

const BASE58_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const eventSchema = z.object({
  signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/),
  slot: z.number().int().nonnegative().safe().optional(),
  type: z.string().min(1).max(128).optional(),
  accountData: z.array(
    z.object({ account: z.string().regex(BASE58_ADDRESS) })
  ).max(256).optional()
});

export type NormalizedWebhookEvent = {
  provider: "helius";
  providerEventId: string;
  transactionSignature: string;
  transactionSlot: string | null;
  accountAddress: string | null;
  eventType: string | null;
  payload: {
    signature: string;
    slot: number | null;
    type: string | null;
  };
};

type TransactionBindingEnvelope = {
  slot: number;
  transaction?: {
    signatures?: unknown;
    message?: { accountKeys?: unknown };
  };
};

export function getWebhookTransactionBindingError(input: {
  requestedSignature: string;
  expectedSlot: string | null;
  accountAddress: string | null;
  transaction: TransactionBindingEnvelope;
}): string | null {
  const chainTransaction = input.transaction.transaction;
  if (!chainTransaction || !Array.isArray(chainTransaction.signatures) ||
      !chainTransaction.signatures.includes(input.requestedSignature)) {
    return "transaction_signature_mismatch";
  }
  if (!Number.isSafeInteger(input.transaction.slot)) {
    return "transaction_slot_invalid";
  }
  if (input.expectedSlot !== null &&
      String(input.transaction.slot) !== input.expectedSlot) {
    return "transaction_slot_mismatch";
  }
  if (input.accountAddress !== null) {
    const accountKeys = chainTransaction.message?.accountKeys;
    const publicKeys = Array.isArray(accountKeys)
      ? accountKeys.flatMap((entry) => {
          if (typeof entry === "string") return [entry];
          if (entry && typeof entry === "object" &&
              "pubkey" in entry && typeof entry.pubkey === "string") {
            return [entry.pubkey];
          }
          return [];
        })
      : [];
    if (!publicKeys.includes(input.accountAddress)) {
      return "webhook_account_hint_mismatch";
    }
  }
  return null;
}

function normalizeEvents(payload: unknown): NormalizedWebhookEvent[] | null {
  const parsed = z.array(eventSchema).min(1).max(100).safeParse(payload);
  if (!parsed.success) return null;

  const uniqueEvents = new Map<string, NormalizedWebhookEvent>();
  for (const event of parsed.data) {
    const transactionSlot = event.slot === undefined ? null : String(event.slot);
    const accountAddress = [...new Set(
      (event.accountData ?? []).map((item) => item.account)
    )].sort()[0] ?? null;
    const eventType = event.type ?? null;
    const prior = uniqueEvents.get(event.signature);
    if (prior) {
      if (prior.transactionSlot !== transactionSlot ||
          prior.accountAddress !== accountAddress ||
          prior.eventType !== eventType) {
        return null;
      }
      continue;
    }
    uniqueEvents.set(event.signature, {
      provider: "helius",
      providerEventId: event.signature,
      transactionSignature: event.signature,
      transactionSlot,
      accountAddress,
      eventType,
      payload: {
        signature: event.signature,
        slot: event.slot ?? null,
        type: eventType
      }
    });
  }
  return [...uniqueEvents.values()];
}

export function normalizeHeliusWebhookPayload(
  payload: unknown
): NormalizedWebhookEvent[] | null {
  if (!Array.isArray(payload)) return null;
  return normalizeEvents(payload);
}
