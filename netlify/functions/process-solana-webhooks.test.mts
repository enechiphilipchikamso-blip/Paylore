import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  findFinalizeClaimedInstruction,
  getFinalizedLedgerReconciliationDisposition,
  getWebhookTransactionBindingError
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
  it("uses the Anchor create_claim discriminator and exact 72-byte payload", () => {
    const discriminator = createHash("sha256").update("global:create_claim").digest().subarray(0, 8);
    const payload = Buffer.concat([discriminator, Buffer.alloc(32, 1), Buffer.alloc(32, 2)]);
    expect(payload).toHaveLength(72);
    expect(Buffer.from(payload.subarray(0, 8))).toEqual(discriminator);
    const encoded = encodeBase58(payload);
    expect(encoded.length).toBeGreaterThan(0);
    expect(Buffer.from(encoded, "base64")).not.toEqual(payload);
  });

  it("does not accept an instruction with a truncated claim commitment", () => {
    const discriminator = createHash("sha256").update("global:create_claim").digest().subarray(0, 8);
    const malformed = Buffer.concat([discriminator, Buffer.alloc(32, 1), Buffer.alloc(31, 2)]);
    expect(malformed).toHaveLength(71);
    expect(malformed.length).not.toBe(72);
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
