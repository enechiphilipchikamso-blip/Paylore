import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const eventSchema = z.object({
  signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/),
  slot: z.number().int().nonnegative().safe().optional(),
  type: z.string().min(1).max(128).optional()
});

export type NormalizedWebhookEvent = {
  provider: "helius" | "quicknode";
  providerEventId: string;
  transactionSignature: string;
  transactionSlot: string | null;
  eventType: string | null;
  payload: {
    signature: string;
    slot: number | null;
    type: string | null;
  };
};

export function verifyQuickNodeWebhookHmac(input: {
  secret: string;
  nonce: string;
  timestamp: string;
  payload: string;
  signature: string;
}): boolean {
  if (
    !input.secret ||
    !input.nonce ||
    !input.timestamp ||
    !/^[a-f0-9]{64}$/i.test(input.signature)
  ) {
    return false;
  }

  const expected = createHmac("sha256", Buffer.from(input.secret, "utf8"))
    .update(`${input.nonce}${input.timestamp}${input.payload}`, "utf8")
    .digest();
  const provided = Buffer.from(input.signature, "hex");
  return (
    provided.length === expected.length &&
    timingSafeEqual(expected, provided)
  );
}

function normalizeEvents(
  payload: unknown,
  provider: NormalizedWebhookEvent["provider"]
): NormalizedWebhookEvent[] | null {
  const parsed = z.array(eventSchema).min(1).max(100).safeParse(payload);
  if (!parsed.success) return null;

  const uniqueEvents = new Map<string, NormalizedWebhookEvent>();
  for (const event of parsed.data) {
    if (uniqueEvents.has(event.signature)) continue;
    uniqueEvents.set(event.signature, {
      provider,
      providerEventId: event.signature,
      transactionSignature: event.signature,
      transactionSlot: event.slot === undefined ? null : String(event.slot),
      eventType: event.type ?? null,
      payload: {
        signature: event.signature,
        slot: event.slot ?? null,
        type: event.type ?? null
      }
    });
  }
  return [...uniqueEvents.values()];
}

export function normalizeHeliusWebhookPayload(
  payload: unknown
): NormalizedWebhookEvent[] | null {
  if (!Array.isArray(payload)) return null;
  return normalizeEvents(payload, "helius");
}

export function normalizeQuickNodeWebhookPayload(
  payload: unknown
): NormalizedWebhookEvent[] | null {
  return normalizeEvents(
    Array.isArray(payload) ? payload : [payload],
    "quicknode"
  );
}
