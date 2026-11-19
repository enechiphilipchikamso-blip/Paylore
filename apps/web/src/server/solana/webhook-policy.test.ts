import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  findRecoverClaimInstruction,
  getFinalizedLedgerReconciliationDisposition,
  getWebhookTransactionBindingError,
  normalizeHeliusWebhookPayload,
  parseCreateClaimInstruction
} from "./webhook-policy";

const signature = "1".repeat(64);
const account = "Vote111111111111111111111111111111111111111";
const otherAccount = "11111111111111111111111111111111";
const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function encodeBase58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    encoded = BASE58_ALPHABET[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  let zeroes = 0;
  while (zeroes < bytes.length && bytes[zeroes] === 0) zeroes += 1;
  return "1".repeat(zeroes) + encoded;
}

describe("Helius webhook normalization", () => {
  it("keeps only reconciliation identifiers, records a deterministic account hint, and deduplicates signatures", () => {
    const events = normalizeHeliusWebhookPayload([
      {
        signature,
        slot: 42,
        type: "UNKNOWN",
        accountData: [
          { account, nativeBalanceChange: 900, tokenBalanceChanges: [{ mint: "not-retained" }] }
        ],
        description: "not-retained"
      },
      { signature, slot: 42, type: "UNKNOWN", accountData: [{ account }] }
    ]);

    expect(events).toEqual([{
      provider: "helius",
      providerEventId: signature,
      transactionSignature: signature,
      transactionSlot: "42",
      accountAddress: account,
      eventType: "UNKNOWN",
      payload: { signature, slot: 42, type: "UNKNOWN" }
    }]);
  });

  it("accepts events without optional account hints", () => {
    expect(normalizeHeliusWebhookPayload([{ signature }])).toEqual([{
      provider: "helius",
      providerEventId: signature,
      transactionSignature: signature,
      transactionSlot: null,
      accountAddress: null,
      eventType: null,
      payload: { signature, slot: null, type: null }
    }]);
  });

  it("rejects conflicting duplicate observations for the same signature", () => {
    expect(normalizeHeliusWebhookPayload([
      { signature, slot: 42, accountData: [{ account }] },
      { signature, slot: 43, accountData: [{ account }] }
    ])).toBeNull();
    expect(normalizeHeliusWebhookPayload([
      { signature, slot: 42, accountData: [{ account }] },
      { signature, slot: 42, accountData: [{ account: otherAccount }] }
    ])).toBeNull();
  });

  it("rejects malformed addresses and oversized account hints", () => {
    expect(normalizeHeliusWebhookPayload([
      { signature, accountData: [{ account: "not-an-address" }] }
    ])).toBeNull();
    expect(normalizeHeliusWebhookPayload([
      { signature, accountData: Array.from({ length: 257 }, () => ({ account })) }
    ])).toBeNull();
  });

  it("rejects unsigned, malformed, or oversized deliveries", () => {
    expect(normalizeHeliusWebhookPayload([{ slot: 42 }])).toBeNull();
    expect(normalizeHeliusWebhookPayload([{ signature: "not-a-signature" }])).toBeNull();
    expect(normalizeHeliusWebhookPayload(
      Array.from({ length: 101 }, () => ({ signature }))
    )).toBeNull();
  });
});

describe("Helius transaction trust boundary", () => {
  const transaction = {
    slot: 42,
    transaction: {
      signatures: [signature],
      message: { accountKeys: [
        { pubkey: account, signer: false },
        { pubkey: otherAccount, signer: true }
      ] }
    }
  };

  it("accepts RPC evidence when signature, slot, and account hint all bind", () => {
    expect(getWebhookTransactionBindingError({
      requestedSignature: signature,
      expectedSlot: "42",
      accountAddress: account,
      transaction
    })).toBeNull();
  });

  it.each([
    ["signature", { ...transaction, transaction: {
      ...transaction.transaction, signatures: ["2".repeat(64)]
    } }, "transaction_signature_mismatch"],
    ["slot", { ...transaction, slot: 43 }, "transaction_slot_mismatch"],
    ["account", { ...transaction, transaction: {
      ...transaction.transaction, message: { accountKeys: [otherAccount] }
    } }, "webhook_account_hint_mismatch"],
    ["invalid slot", { ...transaction, slot: Number.MAX_SAFE_INTEGER + 1 }, "transaction_slot_invalid"]
  ])("rejects a mismatched %s", (_name, candidate, expected) => {
    expect(getWebhookTransactionBindingError({
      requestedSignature: signature,
      expectedSlot: "42",
      accountAddress: account,
      transaction: candidate
    })).toBe(expected);
  });

  it("does not require an account hint when none was delivered", () => {
    expect(getWebhookTransactionBindingError({
      requestedSignature: signature,
      expectedSlot: null,
      accountAddress: null,
      transaction
    })).toBeNull();
  });
});


describe("finalized ledger reconciliation policy", () => {
  it("requires ledger evidence from exactly one workspace for a transaction signature", () => {
    expect(getFinalizedLedgerReconciliationDisposition([])).toBe("not_reconciled");
    expect(getFinalizedLedgerReconciliationDisposition(["workspace-a", "workspace-a"])).toBe("reconciled");
    expect(getFinalizedLedgerReconciliationDisposition(["workspace-a", "workspace-b"])).toBe("ambiguous_workspace");
  });
});


describe("finalized recovery instruction trust boundary", () => {
  const programId = "PayloreProgram111111111111111111111111111";
  const authority = "ReserveAuthority111111111111111111111111";
  const accounts = [
    "Contributor11111111111111111111111111111",
    "Workspace111111111111111111111111111111",
    "ReserveState111111111111111111111111111",
    authority,
    "ReserveToken1111111111111111111111111111",
    "WrappedMint11111111111111111111111111111",
    "Claim111111111111111111111111111111111111",
    "EscrowToken1111111111111111111111111111",
    "Sysvar1nstructions1111111111111111111111111",
    "ProofContext111111111111111111111111111"
  ];
  const recoveryData = encodeBase58(Buffer.concat([
    createHash("sha256").update("global:recover_claim").digest().subarray(0, 8),
    Buffer.alloc(32, 5)
  ]));
  const makeTransaction = (instructionAccounts = accounts, signed = true) => {
    const keys = [...new Set([...accounts, "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"])];
    return {
      slot: 123,
      transaction: {
        signatures: ["5".repeat(64)],
        message: {
          accountKeys: keys.map((pubkey) => ({ pubkey, signer: pubkey === authority && signed })),
          instructions: [
            {
              programId: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
              accounts: [accounts[7], accounts[5], accounts[4], authority, accounts[9]],
              data: encodeBase58(Uint8Array.of(27, 7))
            },
            { programId, accounts: instructionAccounts, data: recoveryData }
          ]
        }
      }
    };
  };

  it("maps the actual ten-account recovery instruction only when bound to the preceding escrow-to-reserve transfer", () => {
    expect(findRecoverClaimInstruction({
      transaction: makeTransaction(),
      payrollProgramId: programId
    })).toEqual({
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
      reasonCommitment: "05".repeat(32)
    });
  });

  it("rejects the obsolete four-account recovery layout", () => {
    expect(findRecoverClaimInstruction({
      transaction: makeTransaction([accounts[3], accounts[0], accounts[2], accounts[6]]),
      payrollProgramId: programId
    })).toMatchObject({ kind: "invalid", errorCode: "recover_claim_account_shape_invalid" });
  });

  it("rejects an unsigned reserve authority", () => {
    expect(findRecoverClaimInstruction({
      transaction: makeTransaction(accounts, false),
      payrollProgramId: programId
    })).toMatchObject({ kind: "invalid", errorCode: "recover_claim_reserve_authority_not_verified" });
  });

  it("rejects a recovery instruction that is not immediately preceded by its exact transfer", () => {
    const transaction = makeTransaction();
    transaction.transaction.message.instructions.splice(1, 0, {
      programId,
      accounts: [accounts[0]],
      data: encodeBase58(Uint8Array.of(1))
    });
    expect(findRecoverClaimInstruction({ transaction, payrollProgramId: programId }))
      .toMatchObject({ kind: "invalid", errorCode: "recover_claim_transfer_not_atomically_bound" });
  });

  it("rejects duplicate recovery instructions in one transaction", () => {
    const transaction = makeTransaction();
    transaction.transaction.message.instructions.push(transaction.transaction.message.instructions[1]);
    expect(findRecoverClaimInstruction({ transaction, payrollProgramId: programId }))
      .toMatchObject({ kind: "invalid", errorCode: "duplicate_recover_claim_instruction" });
  });
});

describe("create_claim webhook instruction parsing", () => {
  const programId = "PayrollProgram1111111111111111111111111111111";
  const createClaimDiscriminator = createHash("sha256")
    .update("global:create_claim")
    .digest()
    .subarray(0, 8);
  const currentAccounts = [
    "authority-address", "payer-address", "contributor-address",
    "workspace-address", "claim-address", "11111111111111111111111111111111"
  ];

  /** Builds the current layout: 144 + 32 * proofLength bytes of Borsh data. */
  function claimInstruction(options: {
    proofLength?: number;
    declaredProofLength?: number;
    extraBytes?: number;
    discriminator?: Uint8Array;
    programId?: string;
    accounts?: unknown[];
    data?: unknown;
  } = {}) {
    const proofLength = options.proofLength ?? 1;
    const leafIndex = Buffer.alloc(4);
    leafIndex.writeUInt32LE(1);
    const declared = Buffer.alloc(4);
    declared.writeUInt32LE(options.declaredProofLength ?? proofLength);
    const data = Buffer.concat([
      options.discriminator ?? createClaimDiscriminator,
      Buffer.alloc(32, 1), // claim_id
      Buffer.alloc(32, 2), // allocation_commitment
      Buffer.alloc(32, 3), // amount_commitment
      leafIndex,           // amount_commitment_leaf_index
      declared,            // amount_commitment_proof length
      Buffer.alloc(32 * proofLength, 4),
      Buffer.alloc(32, 5), // escrow_token_account
      Buffer.alloc(options.extraBytes ?? 0, 9)
    ]);
    return {
      programId: options.programId ?? programId,
      accounts: options.accounts ?? currentAccounts,
      data: "data" in options ? options.data : encodeBase58(data)
    };
  }

  it("parses the current layout and reads each account by its current position", () => {
    expect(parseCreateClaimInstruction(claimInstruction(), programId)).toEqual({
      claimId: "01".repeat(32),
      allocationCommitment: "02".repeat(32),
      authorityAddress: "authority-address",
      payerAddress: "payer-address",
      contributorAddress: "contributor-address",
      workspaceAddress: "workspace-address",
      claimAddress: "claim-address"
    });
  });

  it("accepts every proof depth from an empty proof up to the supported maximum", () => {
    for (const proofLength of [0, 1, 2, 16]) {
      expect(
        parseCreateClaimInstruction(claimInstruction({ proofLength }), programId)
      ).not.toBeNull();
    }
  });

  it("does not recognize the previous 72-byte, five-account layout", () => {
    const legacyData = Buffer.concat([
      createClaimDiscriminator, Buffer.alloc(32, 1), Buffer.alloc(32, 2)
    ]);
    expect(legacyData).toHaveLength(72);
    expect(parseCreateClaimInstruction({
      programId,
      data: encodeBase58(legacyData),
      accounts: ["authority-address", "contributor-address", "workspace-address", "claim-address", "11111111111111111111111111111111"]
    }, programId)).toBeNull();
    expect(parseCreateClaimInstruction(claimInstruction({
      accounts: currentAccounts.slice(0, 5)
    }), programId)).toBeNull();
  });

  it("rejects the wrong account count and non-string accounts", () => {
    expect(parseCreateClaimInstruction(
      claimInstruction({ accounts: [...currentAccounts, "extra-account"] }), programId
    )).toBeNull();
    expect(parseCreateClaimInstruction(
      claimInstruction({ accounts: [...currentAccounts.slice(0, 5), 7] }), programId
    )).toBeNull();
    expect(parseCreateClaimInstruction(
      claimInstruction({ accounts: "not-an-array" as unknown as unknown[] }), programId
    )).toBeNull();
  });

  it("rejects data whose length does not match its declared proof length", () => {
    expect(parseCreateClaimInstruction(
      claimInstruction({ proofLength: 1, declaredProofLength: 2 }), programId
    )).toBeNull();
    expect(parseCreateClaimInstruction(
      claimInstruction({ proofLength: 2, declaredProofLength: 1 }), programId
    )).toBeNull();
    expect(parseCreateClaimInstruction(
      claimInstruction({ extraBytes: 1 }), programId
    )).toBeNull();
  });

  it("rejects a proof deeper than the verifier supports even when the length is self-consistent", () => {
    expect(parseCreateClaimInstruction(
      claimInstruction({ proofLength: 17 }), programId
    )).toBeNull();
  });

  it("rejects truncated data, a different program, a different instruction and missing data", () => {
    expect(parseCreateClaimInstruction({
      programId,
      accounts: currentAccounts,
      data: encodeBase58(Buffer.concat([createClaimDiscriminator, Buffer.alloc(100, 1)]))
    }, programId)).toBeNull();
    expect(parseCreateClaimInstruction(
      claimInstruction({ programId: "SomeOtherProgram111111111111111111111111111" }), programId
    )).toBeNull();
    expect(parseCreateClaimInstruction(claimInstruction({
      discriminator: createHash("sha256").update("global:finalize_claimed").digest().subarray(0, 8)
    }), programId)).toBeNull();
    expect(parseCreateClaimInstruction(claimInstruction({ data: undefined }), programId)).toBeNull();
    expect(parseCreateClaimInstruction(claimInstruction({ data: "0OIl-not-base58" }), programId)).toBeNull();
  });

  it("matches the account order and argument list declared in the Payroll Program source", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../../../../../programs/payroll/src/lib.rs", import.meta.url)),
      "utf8"
    );
    const handler = /pub fn create_claim\(([\s\S]*?)\)\s*->\s*Result<\(\)>/.exec(source);
    expect(handler).not.toBeNull();
    const args = [...handler![1]!.matchAll(/^\s*(\w+):/gm)].map((match) => match[1]);
    // The parser reads data in exactly this order (after the 8-byte discriminator).
    expect(args).toEqual([
      "ctx", "claim_id", "allocation_commitment", "amount_commitment",
      "amount_commitment_leaf_index", "amount_commitment_proof", "escrow_token_account"
    ]);
    const accountsStruct = /pub struct CreateClaim<'info> \{([\s\S]*?)\n\}/.exec(source);
    expect(accountsStruct).not.toBeNull();
    const accounts = [...accountsStruct![1]!.matchAll(/^\s*pub (\w+):/gm)].map((match) => match[1]);
    // The parser reads accounts in exactly this order.
    expect(accounts).toEqual([
      "authority", "payer", "contributor", "workspace", "claim", "system_program"
    ]);
  });
});
