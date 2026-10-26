import { describe, expect, it, vi } from "vitest";
import type { Database } from "./client";
import { persistSolanaWebhookEvents } from "./repositories";
import { solanaWebhookEvents } from "./schema";

describe("Solana webhook event replay idempotency", () => {
  it("counts a previously stored provider event as a duplicate", async () => {
    const returning = vi.fn().mockResolvedValue([]);
    const onConflictDoNothing = vi.fn(() => ({ returning }));
    const values = vi.fn(() => ({ onConflictDoNothing }));
    const insert = vi.fn(() => ({ values }));
    const db = { insert } as unknown as Database;
    const event = {
      provider: "helius" as const,
      providerEventId: "provider-event-1",
      transactionSignature: "1".repeat(64),
      transactionSlot: "42",
      accountAddress: null,
      eventType: "payroll-create_claim",
      payload: { signature: "1".repeat(64), slot: 42 },
      status: "received" as const
    };
    await expect(persistSolanaWebhookEvents(db, [event])).resolves.toEqual({ inserted: 0, duplicates: 1 });
    expect(insert).toHaveBeenCalledWith(solanaWebhookEvents);
    expect(values).toHaveBeenCalledWith([event]);
    expect(onConflictDoNothing).toHaveBeenCalledWith({
      target: [solanaWebhookEvents.provider, solanaWebhookEvents.providerEventId]
    });
    expect(returning).toHaveBeenCalledOnce();
  });
});
