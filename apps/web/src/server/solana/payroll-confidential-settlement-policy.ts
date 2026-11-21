import { nonDivisibleSequentialInstructionPlan, type Instruction, type InstructionPlan } from "@solana/kit";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS } from "@solana-program/zk-elgamal-proof";

export function isExpectedConfidentialTransfer(
  instruction: Instruction,
  expected: { source: string; mint: string; destination: string }
): boolean {
  const accounts = instruction.accounts ?? [];
  return instruction.programAddress === TOKEN_2022_PROGRAM_ADDRESS &&
    (instruction.data?.length ?? 0) >= 2 && instruction.data?.[0] === 27 && instruction.data?.[1] === 7 &&
    accounts.length >= 3 && accounts[0]?.address === expected.source &&
    accounts[1]?.address === expected.mint && accounts[2]?.address === expected.destination;
}

export function getProofContextAddresses(plan: InstructionPlan): string[] {
  const addresses: string[] = [];
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return;
    const value = node as Record<string, unknown>;
    const rawInstruction = value.instruction;
    if (rawInstruction !== null && typeof rawInstruction === "object" && !Array.isArray(rawInstruction)) {
      const instruction = rawInstruction as Record<string, unknown>;
      const accounts = Array.isArray(instruction.accounts) ? instruction.accounts : [];
      const first = accounts[0];
      const firstAddress = first !== null && typeof first === "object"
        ? (first as Record<string, unknown>).address
        : undefined;
      if (instruction.programAddress === ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS && typeof firstAddress === "string") {
        addresses.push(firstAddress);
      }
    }
    if (Array.isArray(value.plans)) value.plans.forEach(visit);
  };
  visit(plan);
  return [...new Set(addresses)];
}

/** Atomically reserves the entitlement for settlement with the confidential transfer; final CLAIMED awaits server reconciliation. */
export function bindSettlementPendingStateToConfidentialTransfer(
  plan: InstructionPlan,
  markSettlementPending: Instruction,
  expected: { source: string; mint: string; destination: string }
): InstructionPlan {
  if (plan.kind !== "sequential" || plan.plans.length !== 3 ||
      plan.plans[1]?.kind !== "single" ||
      !isExpectedConfidentialTransfer(plan.plans[1].instruction, expected)) {
    throw new Error("The official Token-2022 confidential transfer plan shape has changed.");
  }
  return {
    ...plan,
    plans: [plan.plans[0]!, nonDivisibleSequentialInstructionPlan([plan.plans[1].instruction, markSettlementPending]), plan.plans[2]!]
  };
}

export type TransactionFinality = "finalized" | "failed" | "pending";

/** Only finalized outcomes are authoritative; processed failures can disappear on a fork. */
export function classifyTransactionFinality(
  status: { err?: unknown; confirmationStatus?: string | null } | null | undefined
): TransactionFinality {
  if (!status || status.confirmationStatus !== "finalized") return "pending";
  return status.err === null || status.err === undefined ? "finalized" : "failed";
}

/** Confirms the decrypted reserve debit equals the server-approved integer USDC amount. */
export function matchesExactConfidentialDebit(input: {
  amountBaseUnits: string;
  sourceAvailableBefore: string;
  sourceAvailableAfter: string;
}): boolean {
  if (!/^[1-9][0-9]*$/.test(input.amountBaseUnits) ||
      !/^(0|[1-9][0-9]*)$/.test(input.sourceAvailableBefore) ||
      !/^(0|[1-9][0-9]*)$/.test(input.sourceAvailableAfter)) {
    return false;
  }
  const amount = BigInt(input.amountBaseUnits);
  const before = BigInt(input.sourceAvailableBefore);
  const after = BigInt(input.sourceAvailableAfter);
  return before >= after && before - after === amount;
}

/**
 * A proof-context lock older than this cannot belong to a request that is still
 * running (synchronous functions stop within a minute), so it is an orphan left
 * by a crashed or timed-out request and may be rolled back by an administrator.
 */
export const ORPHANED_ATTEMPT_AFTER_MS = 3 * 60 * 1000;

/** True only for a recorded timestamp older than the orphan threshold; a missing timestamp is never stale. */
export function isOrphanedAttempt(updatedAt: Date | null | undefined, now: number = Date.now()): boolean {
  return updatedAt instanceof Date && now - updatedAt.getTime() > ORPHANED_ATTEMPT_AFTER_MS;
}

/** The ZK ElGamal proof program stores the context-state authority in the first 32 bytes of the account. */
export function readContextStateAuthority(data: unknown): Uint8Array | null {
  if (!(data instanceof Uint8Array) || data.length < 33) return null;
  return data.subarray(0, 32);
}

function sameBytes(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

/**
 * Picks the signer that is the recorded authority of a proof context. Only the
 * authority can close it, and it is whichever account paid for the proof
 * transactions (the Gas Tank), so the signer is read from the account instead of assumed.
 */
export function pickContextStateAuthority<T extends { address: string }>(
  data: unknown,
  candidates: ReadonlyArray<{ signer: T; addressBytes: Uint8Array }>
): T | null {
  const authority = readContextStateAuthority(data);
  if (!authority) return null;
  return candidates.find((candidate) => sameBytes(candidate.addressBytes, authority))?.signer ?? null;
}

const RESERVE_STATE_DISCRIMINATOR_LENGTH = 8;
const RESERVE_STATE_ADDRESS_LENGTH = 32;

/**
 * Reads the on-chain WorkspaceReserveState (workspace, reserve authority, reserve
 * token account, mint). ConfigureWorkspaceReserve is idempotent for an identical
 * configuration, so an already matching state needs no transaction — and no wait
 * for finality — on every funding or claim request.
 */
export function matchesConfiguredReserveState(
  data: unknown,
  expected: { workspace: Uint8Array; reserveAuthority: Uint8Array; reserveToken: Uint8Array; mint: Uint8Array }
): boolean {
  if (!(data instanceof Uint8Array) ||
      data.length < RESERVE_STATE_DISCRIMINATOR_LENGTH + RESERVE_STATE_ADDRESS_LENGTH * 4 + 1) return false;
  const field = (index: number) => data.subarray(
    RESERVE_STATE_DISCRIMINATOR_LENGTH + index * RESERVE_STATE_ADDRESS_LENGTH,
    RESERVE_STATE_DISCRIMINATOR_LENGTH + (index + 1) * RESERVE_STATE_ADDRESS_LENGTH
  );
  return sameBytes(field(0), expected.workspace) &&
    sameBytes(field(1), expected.reserveAuthority) &&
    sameBytes(field(2), expected.reserveToken) &&
    sameBytes(field(3), expected.mint);
}
