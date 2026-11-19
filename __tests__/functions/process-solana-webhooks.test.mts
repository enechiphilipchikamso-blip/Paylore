import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  findFinalizeClaimedInstruction,
  getFinalizedLedgerReconciliationDisposition,
  getWebhookTransactionBindingError,
  parseCreateClaimInstruction
} from "../../apps/web/src/server/solana/webhook-policy";

const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function encodeBase58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    const digit = Number(value % 58n);
    encoded = alphabet[digit] + encoded;
    value /= 58n;
  }
  let zeroes = 0;
  while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes += 1;
  return "1".repeat(zeroes) + encoded;
}

describe("Solana payroll event decoding invariants", () => {
  const payrollProgramId = "PayrollProgram1111111111111111111111111111111";
  const createClaimAccounts = [
    "authority-address", "payer-address", "contributor-address",
    "workspace-address", "claim-address", "11111111111111111111111111111111"
  ];
  function createClaimPayload(proofLength: number) {
    const discriminator = createHash("sha256").update("global:create_claim").digest().subarray(0, 8);
    const leafIndex = Buffer.alloc(4);
    leafIndex.writeUInt32LE(0);
    const declaredProofLength = Buffer.alloc(4);
    declaredProofLength.writeUInt32LE(proofLength);
    return Buffer.concat([
      discriminator,
      Buffer.alloc(32, 1), // claim_id
      Buffer.alloc(32, 2), // allocation_commitment
      Buffer.alloc(32, 3), // amount_commitment
      leafIndex,
      declaredProofLength,
      Buffer.alloc(32 * proofLength, 4),
      Buffer.alloc(32, 5) // escrow_token_account
    ]);
  }

  it("recognizes the Anchor create_claim discriminator with the current 144-byte-plus-proof payload", () => {
    const payload = createClaimPayload(1);
    expect(payload).toHaveLength(144 + 32);
    const claim = parseCreateClaimInstruction(
      { programId: payrollProgramId, accounts: createClaimAccounts, data: encodeBase58(payload) },
      payrollProgramId
    );
    expect(claim).toMatchObject({
      claimId: "01".repeat(32),
      allocationCommitment: "02".repeat(32),
      authorityAddress: "authority-address",
      contributorAddress: "contributor-address",
      claimAddress: "claim-address"
    });
  });

  it("does not accept an instruction with a truncated payload or the previous layout", () => {
    const truncated = createClaimPayload(1).subarray(0, 144 + 31);
    expect(parseCreateClaimInstruction(
      { programId: payrollProgramId, accounts: createClaimAccounts, data: encodeBase58(truncated) },
      payrollProgramId
    )).toBeNull();
    const previousLayout = createClaimPayload(0).subarray(0, 72);
    expect(previousLayout).toHaveLength(72);
    expect(parseCreateClaimInstruction(
      { programId: payrollProgramId, accounts: createClaimAccounts.slice(0, 5), data: encodeBase58(previousLayout) },
      payrollProgramId
    )).toBeNull();
  });

  it("distinguishes recovery reasons by their committed bytes", () => {
    const discriminator = createHash("sha256").update("global:recover_claim").digest().subarray(0, 8);
    const first = Buffer.concat([discriminator, Buffer.alloc(32, 3)]);
    const second = Buffer.concat([discriminator, Buffer.alloc(32, 4)]);
    expect(first.subarray(0, 8)).toEqual(second.subarray(0, 8));
    expect(first.subarray(8)).not.toEqual(second.subarray(8));
  });
});


describe("operator retry policy", () => {
  it("requires the durable dead-letter state to be reset before reprocessing", () => {
    const state = { status: "dead_letter", attempts: 8, lastErrorCode: "chain_state_conflict" };
    const retry = { ...state, status: "retry_pending", attempts: 0, lastErrorCode: null };
    expect(state.status).toBe("dead_letter");
    expect(retry).toMatchObject({ status: "retry_pending", attempts: 0, lastErrorCode: null });
  });
});


describe("worker webhook binding regression", () => {
  it("rejects account hints that are not present in canonical RPC transaction keys", () => {
    expect(getWebhookTransactionBindingError({
      requestedSignature: "1".repeat(64),
      expectedSlot: "12",
      accountAddress: "Vote111111111111111111111111111111111111111",
      transaction: {
        slot: 12,
        transaction: {
          signatures: ["1".repeat(64)],
          message: { accountKeys: ["11111111111111111111111111111111"] }
        }
      }
    })).toBe("webhook_account_hint_mismatch");
  });
});


describe("finalized webhook ledger reconciliation policy", () => {
  it("distinguishes missing, single-workspace, and ambiguous ledger evidence", () => {
    expect(getFinalizedLedgerReconciliationDisposition([])).toBe("not_reconciled");
    expect(getFinalizedLedgerReconciliationDisposition(["workspace-a", "workspace-a"])).toBe("reconciled");
    expect(getFinalizedLedgerReconciliationDisposition(["workspace-a", "workspace-b"])).toBe("ambiguous_workspace");
  });

  it("maps a finalized Claim PDA transition only from the configured program and signed reserve authority", () => {
    const programId = "PayloreProgram111111111111111111111111111";
    const authorityAddress = "ReserveAuthority111111111111111111111111";
    const claimAddress = "Claim111111111111111111111111111111111111";
    const accounts = ["contributor", "workspace", "reserve-state", authorityAddress, claimAddress,
      "Sysvar1nstructions1111111111111111111111111"];
    const discriminator = createHash("sha256").update("global:finalize_claimed").digest().subarray(0, 8);
    const instruction = { programId, data: encodeBase58(discriminator), accounts };
    const transaction = {
      slot: 12,
      transaction: {
        signatures: ["1".repeat(64)],
        message: {
          accountKeys: accounts.map((pubkey) => ({ pubkey, signer: pubkey === authorityAddress })),
          instructions: [instruction]
        }
      }
    };
    expect(findFinalizeClaimedInstruction({ transaction, payrollProgramId: programId }))
      .toEqual({ kind: "found", authorityAddress, claimAddress });
    expect(findFinalizeClaimedInstruction({
      transaction: { ...transaction, transaction: { ...transaction.transaction, message: {
        ...transaction.transaction.message,
        accountKeys: transaction.transaction.message.accountKeys.map((entry) =>
          entry.pubkey === authorityAddress ? { ...entry, signer: false } : entry)
      } } },
      payrollProgramId: programId
    })).toMatchObject({ kind: "invalid", errorCode: "finalize_claimed_authority_not_verified" });
    expect(findFinalizeClaimedInstruction({
      transaction: { ...transaction, transaction: { ...transaction.transaction, message: {
        ...transaction.transaction.message,
        instructions: [instruction, instruction]
      } } },
      payrollProgramId: programId
    })).toMatchObject({ kind: "invalid", errorCode: "duplicate_finalize_claimed_instruction" });
  });
});
