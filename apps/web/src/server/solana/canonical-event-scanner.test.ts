import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { findSupportedPayrollEvent, scanCanonicalSignaturePage } from "./canonical-event-scanner";

function base58(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  let result = "";
  while (n) { result = alphabet[Number(n % 58n)] + result; n /= 58n; }
  return result || "1";
}

describe("canonical event discovery", () => {
  it("uses finalized signature pages and persists a high-water mark", async () => {
    const scan = await scanCanonicalSignaturePage({
      address: "watched-account",
      cursor: null,
      fetchSignatures: async (_address, options) => {
        expect(options).toMatchObject({ commitment: "finalized", limit: 25 });
        return [{ signature: "signature-1", slot: 7 }];
      },
      inspect: async () => ({ ready: true, event: null })
    });
    expect(scan?.cursor).toMatchObject({
      address: "watched-account", highWaterSignature: "signature-1",
      backfillBeforeSignature: null
    });
  });

  it("continues backfill pages without moving the high-water signature", async () => {
    const cursor = {
      address: "watched-account", highWaterSignature: "high-water",
      backfillBeforeSignature: "oldest-seen", backfillUntilSignature: "previous-high-water"
    };
    const optionsSeen: unknown[] = [];
    const result = await scanCanonicalSignaturePage({
      address: cursor.address,
      cursor,
      fetchSignatures: async (_address, options) => {
        optionsSeen.push(options);
        return Array.from({ length: 25 }, (_, index) => ({ signature: "page-" + index, slot: index + 1 }));
      },
      inspect: async () => ({ ready: true, event: null })
    });
    expect(optionsSeen[0]).toMatchObject({
      before: "oldest-seen", until: "previous-high-water", commitment: "finalized", limit: 25
    });
    expect(result?.cursor).toMatchObject({
      highWaterSignature: "high-water",
      backfillBeforeSignature: "page-24",
      backfillUntilSignature: "previous-high-water"
    });
  });

  it("does not advance a cursor past a transaction that cannot be inspected", async () => {
    await expect(scanCanonicalSignaturePage({
      address: "watched-account",
      cursor: { address: "watched-account", highWaterSignature: "prior", backfillBeforeSignature: null, backfillUntilSignature: null },
      fetchSignatures: async () => [{ signature: "next", slot: 8 }],
      inspect: async () => ({ ready: false })
    })).resolves.toBeNull();
  });

  it("maps only configured Payroll Program instruction discriminators", () => {
    const programId = "payroll-program";
    const data = base58(createHash("sha256").update("global:recover_claim").digest().subarray(0, 8));
    expect(findSupportedPayrollEvent({
      transaction: { message: { instructions: [{ programId, data }] } }
    }, programId)).toBe("recover_claim");
    expect(findSupportedPayrollEvent({
      transaction: { message: { instructions: [{ programId: "other-program", data }] } }
    }, programId)).toBeNull();
  });
});
