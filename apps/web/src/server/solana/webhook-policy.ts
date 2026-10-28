import { createHash } from "node:crypto";
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
    message?: { accountKeys?: unknown; instructions?: unknown };
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


export type FinalizeClaimedInstructionMatch =
  | { kind: "not_found" }
  | { kind: "invalid"; errorCode: string }
  | { kind: "found"; authorityAddress: string; claimAddress: string };

const FINALIZE_CLAIMED_DISCRIMINATOR = createHash("sha256")
  .update("global:finalize_claimed")
  .digest()
  .subarray(0, 8);
const INSTRUCTIONS_SYSVAR = "Sysvar1nstructions1111111111111111111111111";

function decodeBase58Instruction(value: string): Uint8Array | null {
  if (!value) return null;
  let number = 0n;
  for (const character of value) {
    const digit = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz".indexOf(character);
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

/** Identifies the only valid on-chain finalization instruction shape before app-state reconciliation. */
export function findFinalizeClaimedInstruction(input: {
  transaction: TransactionBindingEnvelope;
  payrollProgramId: string;
}): FinalizeClaimedInstructionMatch {
  const message = input.transaction.transaction?.message;
  const instructions = Array.isArray(message?.instructions) ? message.instructions : [];
  const accountKeys = Array.isArray(message?.accountKeys) ? message.accountKeys : [];
  const publicKeys = accountKeys.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (entry && typeof entry === "object" &&
        "pubkey" in entry && typeof entry.pubkey === "string") return [entry.pubkey];
    return [];
  });
  const signers = accountKeys.flatMap((entry) => {
    if (entry && typeof entry === "object" &&
        "pubkey" in entry && typeof entry.pubkey === "string" &&
        "signer" in entry && entry.signer === true) return [entry.pubkey];
    return [];
  });
  let match: { authorityAddress: string; claimAddress: string } | null = null;

  for (const rawInstruction of instructions) {
    if (!rawInstruction || typeof rawInstruction !== "object") continue;
    const instruction = rawInstruction as Record<string, unknown>;
    if (instruction.programId !== input.payrollProgramId ||
        typeof instruction.data !== "string") continue;
    const data = decodeBase58Instruction(instruction.data);
    if (!data || data.length < 8 ||
        !FINALIZE_CLAIMED_DISCRIMINATOR.every((byte, index) => data[index] === byte)) continue;
    if (data.length !== 8) {
      return { kind: "invalid", errorCode: "finalize_claimed_instruction_data_invalid" };
    }
    if (match) {
      return { kind: "invalid", errorCode: "duplicate_finalize_claimed_instruction" };
    }
    const accounts = instruction.accounts;
    if (!Array.isArray(accounts) || accounts.length !== 6 ||
        accounts.some((account) => typeof account !== "string")) {
      return { kind: "invalid", errorCode: "finalize_claimed_account_shape_invalid" };
    }
    const authorityAddress = accounts[3] as string;
    const claimAddress = accounts[4] as string;
    if (accounts.some((account) => !publicKeys.includes(account as string))) {
      return { kind: "invalid", errorCode: "finalize_claimed_account_mapping_invalid" };
    }
    if (!authorityAddress || !claimAddress ||
        accounts[5] !== INSTRUCTIONS_SYSVAR ||
        !signers.includes(authorityAddress)) {
      return { kind: "invalid", errorCode: "finalize_claimed_authority_not_verified" };
    }
    match = { authorityAddress, claimAddress };
  }
  return match ? { kind: "found", ...match } : { kind: "not_found" };
}

export function getFinalizedLedgerReconciliationDisposition(
  workspaceIds: string[]
): "not_reconciled" | "reconciled" | "ambiguous_workspace" {
  const unique = new Set(workspaceIds.filter((workspaceId) => workspaceId.length > 0));
  if (unique.size === 0) return "not_reconciled";
  return unique.size === 1 ? "reconciled" : "ambiguous_workspace";
}


export type RecoverClaimInstructionMatch =
  | { kind: "not_found" }
  | { kind: "invalid"; errorCode: string }
  | {
      kind: "found";
      contributorAddress: string;
      workspaceAddress: string;
      reserveStateAddress: string;
      reserveAuthorityAddress: string;
      reserveTokenAccount: string;
      mint: string;
      claimAddress: string;
      escrowTokenAccount: string;
      amountCommitmentContext: string;
      reasonCommitment: string;
    };

const RECOVER_CLAIM_DISCRIMINATOR = createHash("sha256")
  .update("global:recover_claim")
  .digest()
  .subarray(0, 8);
const TOKEN_2022_PROGRAM_ID = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

/** Trusts recovery only when the ten-account Anchor instruction is atomically adjacent to its exact escrow-to-reserve transfer. */
export function findRecoverClaimInstruction(input: {
  transaction: TransactionBindingEnvelope;
  payrollProgramId: string;
}): RecoverClaimInstructionMatch {
  const message = input.transaction.transaction?.message;
  const instructions = Array.isArray(message?.instructions) ? message.instructions : [];
  const accountKeys = Array.isArray(message?.accountKeys) ? message.accountKeys : [];
  const publicKeys = accountKeys.flatMap((entry) => {
    if (typeof entry === "string") return [entry];
    if (entry && typeof entry === "object" && "pubkey" in entry && typeof entry.pubkey === "string") {
      return [entry.pubkey];
    }
    return [];
  });
  const signers = accountKeys.flatMap((entry) => {
    if (entry && typeof entry === "object" &&
        "pubkey" in entry && typeof entry.pubkey === "string" &&
        "signer" in entry && entry.signer === true) return [entry.pubkey];
    return [];
  });
  let result: Extract<RecoverClaimInstructionMatch, { kind: "found" }> | null = null;
  let matchingTransfers = 0;

  for (const [index, raw] of instructions.entries()) {
    if (!raw || typeof raw !== "object") continue;
    const instruction = raw as Record<string, unknown>;
    if (instruction.programId !== input.payrollProgramId || typeof instruction.data !== "string") continue;
    const data = decodeBase58Instruction(instruction.data);
    if (!data || data.length < 8 ||
        !RECOVER_CLAIM_DISCRIMINATOR.every((byte, offset) => data[offset] === byte)) continue;
    if (data.length !== 40) return { kind: "invalid", errorCode: "recover_claim_instruction_data_invalid" };
    if (result) return { kind: "invalid", errorCode: "duplicate_recover_claim_instruction" };

    const rawAccounts = instruction.accounts;
    if (!Array.isArray(rawAccounts) || rawAccounts.length !== 10 ||
        rawAccounts.some((account) => typeof account !== "string")) {
      return { kind: "invalid", errorCode: "recover_claim_account_shape_invalid" };
    }
    const accounts = rawAccounts as string[];
    if (accounts.some((account) => !publicKeys.includes(account))) {
      return { kind: "invalid", errorCode: "recover_claim_account_mapping_invalid" };
    }
    if (!signers.includes(accounts[3])) {
      return { kind: "invalid", errorCode: "recover_claim_reserve_authority_not_verified" };
    }
    if (accounts[8] !== INSTRUCTIONS_SYSVAR || !accounts[9]) {
      return { kind: "invalid", errorCode: "recover_claim_context_account_invalid" };
    }

    const prior = instructions[index - 1];
    if (!prior || typeof prior !== "object") {
      return { kind: "invalid", errorCode: "recover_claim_transfer_not_atomically_bound" };
    }
    const transfer = prior as Record<string, unknown>;
    const transferData = typeof transfer.data === "string" ? decodeBase58Instruction(transfer.data) : null;
    const transferAccounts = Array.isArray(transfer.accounts) ? transfer.accounts : [];
    const transferIsBound = transfer.programId === TOKEN_2022_PROGRAM_ID &&
      transferData !== null && transferData.length >= 2 &&
      transferData[0] === 27 && transferData[1] === 7 &&
      transferAccounts.length >= 5 &&
      transferAccounts[0] === accounts[7] &&
      transferAccounts[1] === accounts[5] &&
      transferAccounts[2] === accounts[4] &&
      transferAccounts[4] === accounts[9];
    if (!transferIsBound) {
      return { kind: "invalid", errorCode: "recover_claim_transfer_not_atomically_bound" };
    }

    matchingTransfers++;
    result = {
      kind: "found",
      contributorAddress: accounts[0],
      workspaceAddress: accounts[1],
      reserveStateAddress: accounts[2],
      reserveAuthorityAddress: accounts[3],
      reserveTokenAccount: accounts[4],
      mint: accounts[5],
      claimAddress: accounts[6],
      escrowTokenAccount: accounts[7],
      amountCommitmentContext: accounts[9],
      reasonCommitment: Buffer.from(data.subarray(8)).toString("hex")
    };
  }
  if (result && matchingTransfers !== 1) {
    return { kind: "invalid", errorCode: "recover_claim_transfer_not_atomically_bound" };
  }
  return result ?? { kind: "not_found" };
}
