import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { address, getAddressEncoder, getProgramDerivedAddress } from "@solana/kit";
import { readSolanaRpc } from "./rpc";
import {
  verifyPayrollClaimTransaction,
  verifyPayrollRecoveryTransaction
} from "./payroll-program-verification";

vi.mock("./rpc", () => ({
  readSolanaRpc: vi.fn()
}));
vi.mock("../config", () => ({
  loadPayloreConfig: () => ({
    PAYLORE_PAYROLL_PROGRAM_ID:
      "4zYM9ZjwbAz9jxQ2C69Z83n1s4wceCPk7VzDLKoUnT93"
  })
}));
vi.mock("server-only", () => ({}));

const programId = address("4zYM9ZjwbAz9jxQ2C69Z83n1s4wceCPk7VzDLKoUnT93");
const authorityAddress = "Vote111111111111111111111111111111111111111";
const contributorAddress = "11111111111111111111111111111111";
const workspaceId = "5f7bbaf7-21ab-4e62-95be-84f5d6bf6bb3";
const claimId = "01".repeat(32);
const commitment = "ab".repeat(32);
const amountCommitment = "ef".repeat(32);
const recoveryReasonCommitment = "cd".repeat(32);
const transactionSignature = "5".repeat(64);
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

async function claimInstruction() {
  const workspaceSeed = createHash("sha256")
    .update(`paylore:workspace:v1:${workspaceId}`)
    .digest();
  const [workspace] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [
      new TextEncoder().encode("workspace"),
      getAddressEncoder().encode(address(authorityAddress)),
      workspaceSeed
    ]
  });
  const [claim, claimBump] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [
      new TextEncoder().encode("claim"),
      getAddressEncoder().encode(workspace),
      getAddressEncoder().encode(address(contributorAddress)),
      Buffer.from(claimId, "hex")
    ]
  });
  const discriminator = createHash("sha256")
    .update("global:create_claim")
    .digest()
    .subarray(0, 8);
  const data = Buffer.concat([
    discriminator,
    Buffer.from(claimId, "hex"),
    Buffer.from(commitment, "hex"),
    Buffer.from(amountCommitment, "hex")
  ]);
  return {
    programId,
    accounts: [
      authorityAddress,
      contributorAddress,
      workspace,
      claim,
      "11111111111111111111111111111111"
    ],
    data: encodeBase58(data),
    claimAddress: claim,
    claimBump,
    workspaceAddress: workspace
  };
}

function claimStateAccount(
  instruction: Awaited<ReturnType<typeof claimInstruction>>,
  options: {
    status?: number;
    owner?: string;
    allocationCommitment?: string;
    amountCommitment?: string;
  } = {}
) {
  const discriminator = createHash("sha256")
    .update("account:ClaimState")
    .digest()
    .subarray(0, 8);
  const accountData = Buffer.concat([
    discriminator,
    Buffer.from(getAddressEncoder().encode(address(instruction.workspaceAddress))),
    Buffer.from(getAddressEncoder().encode(address(contributorAddress))),
    Buffer.from(claimId, "hex"),
    Buffer.from(options.allocationCommitment ?? commitment, "hex"),
    Buffer.from(options.amountCommitment ?? amountCommitment, "hex"),
    Buffer.from([options.status ?? 0, instruction.claimBump])
  ]);
  return {
    value: {
      owner: options.owner ?? programId,
      executable: false,
      data: [accountData.toString("base64"), "base64"]
    }
  };
}

async function recoveryInstruction() {
  const claim = await claimInstruction();
  const discriminator = createHash("sha256")
    .update("global:recover_claim")
    .digest()
    .subarray(0, 8);
  return {
    programId,
    accounts: [
      authorityAddress,
      contributorAddress,
      claim.accounts[2],
      claim.claimAddress
    ],
    data: encodeBase58(
      Buffer.concat([
        discriminator,
        Buffer.from(recoveryReasonCommitment, "hex")
      ])
    )
  };
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("payroll program transaction verification", () => {
  it("accepts only finalized Claim PDA instructions for the expected allocation", async () => {
    const instruction = await claimInstruction();
    vi.mocked(readSolanaRpc)
      .mockResolvedValueOnce({
        slot: 42,
        transaction: {
          signatures: [transactionSignature],
          message: {
            accountKeys: [{ pubkey: authorityAddress, signer: true }],
            instructions: [instruction]
          }
        },
        meta: { err: null }
      })
      .mockResolvedValueOnce(claimStateAccount(instruction));

    await expect(
      verifyPayrollClaimTransaction({
        signature: transactionSignature,
        authorityAddress,
        workspaceId,
        allocationCommitment: commitment,
        claims: [{
          claimId,
          claimAddress: instruction.claimAddress,
          contributorAddress,
          amountCommitment
        }]
      })
    ).resolves.toBeUndefined();
  });

  it("rejects a Claim PDA whose on-chain state is not unclaimed", async () => {
    const instruction = await claimInstruction();
    vi.mocked(readSolanaRpc)
      .mockResolvedValueOnce({
        slot: 42,
        transaction: {
          signatures: [transactionSignature],
          message: {
            accountKeys: [{ pubkey: authorityAddress, signer: true }],
            instructions: [instruction]
          }
        },
        meta: { err: null }
      })
      .mockResolvedValueOnce(claimStateAccount(instruction, { status: 1 }));

    await expect(
      verifyPayrollClaimTransaction({
        signature: transactionSignature,
        authorityAddress,
        workspaceId,
        allocationCommitment: commitment,
        claims: [{
          claimId,
          claimAddress: instruction.claimAddress,
          contributorAddress,
          amountCommitment
        }]
      })
    ).rejects.toThrow("does not match the expected workspace");
  });

  it("rejects a Claim PDA whose amount commitment differs from the allocation", async () => {
    const instruction = await claimInstruction();
    vi.mocked(readSolanaRpc)
      .mockResolvedValueOnce({
        slot: 42,
        transaction: {
          signatures: [transactionSignature],
          message: {
            accountKeys: [{ pubkey: authorityAddress, signer: true }],
            instructions: [instruction]
          }
        },
        meta: { err: null }
      })
      .mockResolvedValueOnce(claimStateAccount(instruction, {
        amountCommitment: "cd".repeat(32)
      }));
    await expect(verifyPayrollClaimTransaction({
      signature: transactionSignature,
      authorityAddress,
      workspaceId,
      allocationCommitment: commitment,
      claims: [{
        claimId,
        claimAddress: instruction.claimAddress,
        contributorAddress,
        amountCommitment
      }]
    })).rejects.toThrow("does not match the expected workspace");
  });

  it("rejects a Claim PDA whose account data has a different allocation commitment", async () => {
    const instruction = await claimInstruction();
    vi.mocked(readSolanaRpc)
      .mockResolvedValueOnce({
        slot: 42,
        transaction: {
          signatures: [transactionSignature],
          message: {
            accountKeys: [{ pubkey: authorityAddress, signer: true }],
            instructions: [instruction]
          }
        },
        meta: { err: null }
      })
      .mockResolvedValueOnce(
        claimStateAccount(instruction, {
          allocationCommitment: "cd".repeat(32)
        })
      );

    await expect(
      verifyPayrollClaimTransaction({
        signature: transactionSignature,
        authorityAddress,
        workspaceId,
        allocationCommitment: commitment,
        claims: [{
          claimId,
          claimAddress: instruction.claimAddress,
          contributorAddress,
          amountCommitment
        }]
      })
    ).rejects.toThrow("does not match the expected workspace");
  });

  it("rejects a transaction without the authorized signer", async () => {
    const instruction = await claimInstruction();
    vi.mocked(readSolanaRpc).mockResolvedValue({
      slot: 42,
      transaction: {
        signatures: [transactionSignature],
        message: {
          accountKeys: [{ pubkey: contributorAddress, signer: true }],
          instructions: [instruction]
        }
      },
      meta: { err: null }
    });

    await expect(
      verifyPayrollClaimTransaction({
        signature: transactionSignature,
        authorityAddress,
        workspaceId,
        allocationCommitment: commitment,
        claims: [{
          claimId,
          claimAddress: instruction.claimAddress,
          contributorAddress,
          amountCommitment
        }]
      })
    ).rejects.toThrow("not finalized successfully");
  });

  it("rejects a Claim PDA address that does not derive from its allocation", async () => {
    const instruction = await claimInstruction();
    vi.mocked(readSolanaRpc).mockResolvedValue({
      slot: 42,
      transaction: {
        signatures: [transactionSignature],
        message: {
          accountKeys: [{ pubkey: authorityAddress, signer: true }],
          instructions: [instruction]
        }
      },
      meta: { err: null }
    });

    await expect(
      verifyPayrollClaimTransaction({
        signature: transactionSignature,
        authorityAddress,
        workspaceId,
        allocationCommitment: commitment,
        claims: [{
          claimId,
          claimAddress: authorityAddress,
          contributorAddress,
          amountCommitment
        }]
      })
    ).rejects.toThrow("does not match this allocation");
  });

  it("accepts recovery only when the finalized Claim PDA is RECOVERED for the allocation", async () => {
    const instruction = await recoveryInstruction();
    const claim = await claimInstruction();
    vi.mocked(readSolanaRpc)
      .mockResolvedValueOnce({
        slot: 42,
        transaction: {
          signatures: [transactionSignature],
          message: {
            accountKeys: [{ pubkey: authorityAddress, signer: true }],
            instructions: [instruction]
          }
        },
        meta: { err: null }
      })
      .mockResolvedValueOnce(claimStateAccount(claim, { status: 2 }));

    await expect(
      verifyPayrollRecoveryTransaction({
        signature: transactionSignature,
        authorityAddress,
        workspaceId,
        contributorAddress,
        claimId,
        claimAddress: claim.claimAddress,
        allocationCommitment: commitment,
        recoveryReasonCommitment
      })
    ).resolves.toBeUndefined();
  });

  it("rejects a recovery transaction until the finalized Claim PDA is RECOVERED", async () => {
    const instruction = await recoveryInstruction();
    const claim = await claimInstruction();
    vi.mocked(readSolanaRpc)
      .mockResolvedValueOnce({
        slot: 42,
        transaction: {
          signatures: [transactionSignature],
          message: {
            accountKeys: [{ pubkey: authorityAddress, signer: true }],
            instructions: [instruction]
          }
        },
        meta: { err: null }
      })
      .mockResolvedValueOnce(claimStateAccount(claim, { status: 0 }));

    await expect(
      verifyPayrollRecoveryTransaction({
        signature: transactionSignature,
        authorityAddress,
        workspaceId,
        contributorAddress,
        claimId,
        claimAddress: claim.claimAddress,
        allocationCommitment: commitment,
        recoveryReasonCommitment
      })
    ).rejects.toThrow("not in the expected RECOVERED state");
  });

  it("rejects recovery transactions with a different committed reason", async () => {
    const instruction = await recoveryInstruction();
    const claim = await claimInstruction();
    vi.mocked(readSolanaRpc)
      .mockResolvedValueOnce({
        slot: 42,
        transaction: {
          signatures: [transactionSignature],
          message: {
            accountKeys: [{ pubkey: authorityAddress, signer: true }],
            instructions: [instruction]
          }
        },
        meta: { err: null }
      })
      .mockResolvedValueOnce(claimStateAccount(claim, { status: 2 }));

    await expect(
      verifyPayrollRecoveryTransaction({
        signature: transactionSignature,
        authorityAddress,
        workspaceId,
        contributorAddress,
        claimId,
        claimAddress: claim.claimAddress,
        allocationCommitment: commitment,
        recoveryReasonCommitment: "ef".repeat(32)
      })
    ).rejects.toThrow("does not perform this Claim PDA recovery");
  });
});
