import { z } from "zod";

const eventSchema = z.object({
  signature: z.string().regex(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/),
  slot: z.number().int().nonnegative().safe().optional(),
  type: z.string().min(1).max(128).optional()
});

export type NormalizedWebhookEvent = {
  provider: "helius";
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

function normalizeEvents(payload: unknown): NormalizedWebhookEvent[] | null {
  const parsed = z.array(eventSchema).min(1).max(100).safeParse(payload);
  if (!parsed.success) return null;

  const uniqueEvents = new Map<string, NormalizedWebhookEvent>();
  for (const event of parsed.data) {
    if (uniqueEvents.has(event.signature)) continue;
    uniqueEvents.set(event.signature, {
      provider: "helius",
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
  return normalizeEvents(payload);
}
