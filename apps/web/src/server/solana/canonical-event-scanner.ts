import { createHash } from "node:crypto";

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";

export const CANONICAL_SCAN_PAGE_SIZE = 25;

export type CanonicalSignatureInfo = {
  signature: string;
  slot: number;
  err?: unknown;
};

export type CanonicalScanCursor = {
  address: string;
  highWaterSignature: string | null;
  backfillBeforeSignature: string | null;
  backfillUntilSignature: string | null;
};

export type CanonicalScanEvent = {
  provider: "canonical-rpc-scanner";
  providerEventId: string;
  transactionSignature: string;
  accountAddress: string;
  transactionSlot: string;
  eventType: string;
  payload: { signature: string; slot: number; type: string; sourceAddress: string };
  status: "received";
};

export type CanonicalScanInspection =
  | { ready: false }
  | { ready: true; event: CanonicalScanEvent | null };

export type CanonicalScanPage = {
  cursor: CanonicalScanCursor;
  events: CanonicalScanEvent[];
};

export type SignaturePageOptions = {
  commitment: "finalized";
  limit: number;
  before?: string;
  until?: string;
};

/** Advances one bounded RPC page without moving past an incomplete transaction read. */
export async function scanCanonicalSignaturePage(input: {
  address: string;
  cursor: CanonicalScanCursor | null;
  fetchSignatures: (address: string, options: SignaturePageOptions) => Promise<CanonicalSignatureInfo[]>;
  inspect: (signature: CanonicalSignatureInfo, address: string) => Promise<CanonicalScanInspection>;
}): Promise<CanonicalScanPage | null> {
  const cursor = input.cursor ?? {
    address: input.address,
    highWaterSignature: null,
    backfillBeforeSignature: null,
    backfillUntilSignature: null
  };
  if (cursor.address !== input.address) throw new Error("The canonical reconciliation cursor address does not match.");

  const backfilling = cursor.backfillBeforeSignature !== null;
  const request: SignaturePageOptions = {
    commitment: "finalized",
    limit: CANONICAL_SCAN_PAGE_SIZE,
    ...(backfilling ? { before: cursor.backfillBeforeSignature! } :
      cursor.highWaterSignature ? { until: cursor.highWaterSignature } : {}),
    ...(backfilling && cursor.backfillUntilSignature
      ? { until: cursor.backfillUntilSignature }
      : {})
  };
  const signatures = await input.fetchSignatures(input.address, request);
  const events: CanonicalScanEvent[] = [];
  for (const signature of signatures) {
    if (!signature || typeof signature.signature !== "string" ||
        !Number.isSafeInteger(signature.slot) || signature.slot < 0) return null;
    const inspected = await input.inspect(signature, input.address);
    if (!inspected.ready) return null;
    if (inspected.event) events.push(inspected.event);
  }

  const oldest = signatures.length ? signatures[signatures.length - 1].signature : null;
  if (backfilling) {
    const keepPaging = signatures.length === CANONICAL_SCAN_PAGE_SIZE && oldest !== null;
    return {
      events,
      cursor: {
        address: input.address,
        highWaterSignature: cursor.highWaterSignature,
        backfillBeforeSignature: keepPaging ? oldest : null,
        backfillUntilSignature: keepPaging ? cursor.backfillUntilSignature : null
      }
    };
  }

  const nextHighWater = signatures[0]?.signature ?? cursor.highWaterSignature;
  const startBackfill = signatures.length === CANONICAL_SCAN_PAGE_SIZE && oldest !== null;
  return {
    events,
    cursor: {
      address: input.address,
      highWaterSignature: nextHighWater,
      backfillBeforeSignature: startBackfill ? oldest : null,
      backfillUntilSignature: startBackfill ? cursor.highWaterSignature : null
    }
  };
}

export type CanonicalTransactionLike = {
  transaction?: {
    signatures?: unknown;
    message?: { instructions?: Array<Record<string, unknown>> };
  };
  meta?: { err?: unknown } | null;
};

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

function discriminator(name: string): Uint8Array {
  return createHash("sha256").update(name).digest().subarray(0, 8);
}

const SUPPORTED_PAYROLL_INSTRUCTIONS = new Map([
  ["create_claim", discriminator("global:create_claim")],
  ["finalize_claimed", discriminator("global:finalize_claimed")],
  ["recover_claim", discriminator("global:recover_claim")]
]);

export function findSupportedPayrollEvent(
  transaction: CanonicalTransactionLike,
  payrollProgramId: string
): string | null {
  const instructions = transaction.transaction?.message?.instructions;
  if (!Array.isArray(instructions)) return null;
  const found = new Set<string>();
  for (const instruction of instructions) {
    if (instruction.programId !== payrollProgramId || typeof instruction.data !== "string") continue;
    const data = decodeBase58(instruction.data);
    if (!data || data.length < 8) continue;
    for (const [name, discriminatorBytes] of SUPPORTED_PAYROLL_INSTRUCTIONS) {
      if (discriminatorBytes.every((byte, index) => data[index] === byte)) found.add(name);
    }
  }
  return found.size === 1 ? [...found][0] : null;
}

export function findSystemTransferDestination(transaction: CanonicalTransactionLike): string | null {
  const instructions = transaction.transaction?.message?.instructions;
  if (!Array.isArray(instructions)) return null;
  const destinations = new Set<string>();
  for (const instruction of instructions) {
    if (instruction.programId !== SYSTEM_PROGRAM_ID ||
        (instruction.program !== undefined && instruction.program !== "system") ||
        !instruction.parsed || typeof instruction.parsed !== "object") continue;
    const parsed = instruction.parsed as Record<string, unknown>;
    if (parsed.type !== "transfer" || !parsed.info || typeof parsed.info !== "object") continue;
    const info = parsed.info as Record<string, unknown>;
    if (typeof info.source !== "string" || typeof info.destination !== "string" ||
        (typeof info.lamports !== "string" && typeof info.lamports !== "number")) continue;
    try {
      if (typeof info.lamports === "number" && !Number.isSafeInteger(info.lamports)) continue;
      const amount = BigInt(info.lamports);
      if (amount <= 0n || amount >= (1n << 64n)) continue;
    } catch { continue; }
    destinations.add(info.destination);
  }
  return destinations.size === 1 ? [...destinations][0] : null;
}
