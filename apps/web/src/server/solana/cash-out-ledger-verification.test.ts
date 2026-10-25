import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readSolanaRpc: vi.fn(),
  buildWrappedUsdcUnwrapPlan: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("./rpc", () => ({ readSolanaRpc: mocks.readSolanaRpc }));
vi.mock("../../components/workspace/token-wrap-transaction", () => ({
  buildWrappedUsdcUnwrapPlan: mocks.buildWrappedUsdcUnwrapPlan
}));
vi.mock("@solana-program/token-2022", () => ({
  TOKEN_2022_PROGRAM_ADDRESS: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  TOKEN_PROGRAM_ADDRESS: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
}));

import { CashOutLedgerVerificationError, verifyFinalizedCashOutTransaction } from "./cash-out-ledger-verification";

const WALLET = "ReserveAuthority1111111111111111111111111";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const WRAPPED_MINT = "8wZmMHQY3bCJMhWs8j6BLxvgNLUkCXB2F5tEZPFF8A6q";
const CIRCLE_MINT = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const WRAP_PROGRAM = "58yEtWEhrsRery3w1kZiTXdWofY6efvxmeAZwLrexgQ";
const TOKEN_ACCOUNT = "WrappedSourceTokenAccount111111111111111111";
const CIRCLE_ACCOUNT = "CircleDestinationAccount1111111111111111";
const WRAP_ESCROW = "WrappedMintAuthorityEscrow1111111111111111";
const WRAP_AUTHORITY = "WrappedMintAuthority111111111111111111111";
const SIGNATURE = "5".repeat(88);
const AMOUNT = 1_250_000n;

function encodeBase58(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    encoded = alphabet[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  let leading = 0;
  while (leading < bytes.length && bytes[leading] === 0) leading += 1;
  return "1".repeat(leading) + encoded;
}

function littleEndian(value: bigint, length: number): number[] {
  return Array.from({ length }, (_, index) => Number((value >> BigInt(index * 8)) & 255n));
}

function tokenBalance(
  accountIndex: number,
  mint: string,
  amount: string,
  owner = WALLET,
  programId = TOKEN_2022
) {
  return {
    accountIndex, mint, owner, programId,
    uiTokenAmount: { amount, decimals: 6 }
  };
}

function tx(instructions: unknown[], meta: Record<string, unknown>, accountKeys: string[] = [
  WALLET, TOKEN_ACCOUNT, WRAPPED_MINT, "Sysvar1nstructions1111111111111111111111111",
  "EqualityProofContext111111111111111111111", "RangeProofContext11111111111111111111111"
]) {
  return {
    slot: 77,
    meta,
    transaction: {
      signatures: [SIGNATURE],
      message: {
        header: { numRequiredSignatures: 1 },
        accountKeys,
        instructions
      }
    }
  };
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("server-side public cash-out ledger verification", () => {
  it("accepts only a finalized exact confidential withdrawal and public token credit", async () => {
    mocks.readSolanaRpc.mockResolvedValue(tx([{
      programId: TOKEN_2022,
      accounts: [1, 2, 3, 4, 5, 0],
      data: encodeBase58(Uint8Array.from([27, 6, ...littleEndian(AMOUNT, 8), 6]))
    }], {
      err: null,
      preTokenBalances: [tokenBalance(1, WRAPPED_MINT, "500000")],
      postTokenBalances: [tokenBalance(1, WRAPPED_MINT, "1750000")]
    }));

    await expect(verifyFinalizedCashOutTransaction({
      kind: "confidential_withdrawal", signature: SIGNATURE,
      amountBaseUnits: AMOUNT.toString(), walletAddress: WALLET,
      tokenAccountAddress: TOKEN_ACCOUNT, wrappedMint: WRAPPED_MINT,
      circleMint: null, tokenWrapProgramId: WRAP_PROGRAM
    })).resolves.toEqual({
      amountBaseUnits: AMOUNT.toString(),
      mint: WRAPPED_MINT,
      sourceTokenAccount: TOKEN_ACCOUNT,
      destinationTokenAccount: TOKEN_ACCOUNT
    });
    expect(mocks.readSolanaRpc).toHaveBeenCalledWith("getTransaction", [
      SIGNATURE,
      { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 }
    ]);
  });

  it("rejects a withdrawal amount mismatch even when the token balance changed", async () => {
    mocks.readSolanaRpc.mockResolvedValue(tx([{
      programId: TOKEN_2022,
      accounts: [1, 2, 3, 4, 5, 0],
      data: encodeBase58(Uint8Array.from([27, 6, ...littleEndian(AMOUNT - 1n, 8), 6]))
    }], {
      err: null,
      preTokenBalances: [tokenBalance(1, WRAPPED_MINT, "500000")],
      postTokenBalances: [tokenBalance(1, WRAPPED_MINT, "1750000")]
    }));
    await expect(verifyFinalizedCashOutTransaction({
      kind: "confidential_withdrawal", signature: SIGNATURE,
      amountBaseUnits: AMOUNT.toString(), walletAddress: WALLET,
      tokenAccountAddress: TOKEN_ACCOUNT, wrappedMint: WRAPPED_MINT,
      circleMint: null, tokenWrapProgramId: WRAP_PROGRAM
    })).rejects.toMatchObject({ code: "cash_out_withdraw_instruction_not_verified" });
  });

  it("rejects a withdrawal signed by a different wallet", async () => {
    mocks.readSolanaRpc.mockResolvedValue({
      ...tx([{
        programId: TOKEN_2022,
        accounts: [1, 2, 3, 4, 5, 0],
        data: encodeBase58(Uint8Array.from([27, 6, ...littleEndian(AMOUNT, 8), 6]))
      }], {
        err: null,
        preTokenBalances: [tokenBalance(1, WRAPPED_MINT, "500000")],
        postTokenBalances: [tokenBalance(1, WRAPPED_MINT, "1750000")]
      }),
      transaction: {
        signatures: [SIGNATURE],
        message: {
          header: { numRequiredSignatures: 0 },
          accountKeys: [WALLET, TOKEN_ACCOUNT, WRAPPED_MINT, "Sysvar1nstructions1111111111111111111111111", "EqualityProofContext111111111111111111111", "RangeProofContext11111111111111111111111"],
          instructions: [{
            programId: TOKEN_2022,
            accounts: [1, 2, 3, 4, 5, 0],
            data: encodeBase58(Uint8Array.from([27, 6, ...littleEndian(AMOUNT, 8), 6]))
          }]
        }
      }
    });
    await expect(verifyFinalizedCashOutTransaction({
      kind: "confidential_withdrawal", signature: SIGNATURE,
      amountBaseUnits: AMOUNT.toString(), walletAddress: WALLET,
      tokenAccountAddress: TOKEN_ACCOUNT, wrappedMint: WRAPPED_MINT,
      circleMint: null, tokenWrapProgramId: WRAP_PROGRAM
    })).rejects.toMatchObject({ code: "cash_out_wallet_signature_missing" });
  });

  it("rejects a finalized transaction with a mismatched public credit", async () => {
    mocks.readSolanaRpc.mockResolvedValue(tx([{
      programId: TOKEN_2022,
      accounts: [1, 2, 3, 4, 5, 0],
      data: encodeBase58(Uint8Array.from([27, 6, ...littleEndian(AMOUNT, 8), 6]))
    }], {
      err: null,
      preTokenBalances: [tokenBalance(1, WRAPPED_MINT, "500000")],
      postTokenBalances: [tokenBalance(1, WRAPPED_MINT, "1749999")]
    }));
    await expect(verifyFinalizedCashOutTransaction({
      kind: "confidential_withdrawal", signature: SIGNATURE,
      amountBaseUnits: AMOUNT.toString(), walletAddress: WALLET,
      tokenAccountAddress: TOKEN_ACCOUNT, wrappedMint: WRAPPED_MINT,
      circleMint: null, tokenWrapProgramId: WRAP_PROGRAM
    })).rejects.toMatchObject({ code: "cash_out_balance_delta_invalid" });
  });

  it("rejects failed and missing finalized transactions", async () => {
    mocks.readSolanaRpc.mockResolvedValueOnce(
      tx([], { err: { InstructionError: [0, "Custom"] } })
    );
    await expect(verifyFinalizedCashOutTransaction({
      kind: "confidential_withdrawal", signature: SIGNATURE,
      amountBaseUnits: AMOUNT.toString(), walletAddress: WALLET,
      tokenAccountAddress: TOKEN_ACCOUNT, wrappedMint: WRAPPED_MINT,
      circleMint: null, tokenWrapProgramId: WRAP_PROGRAM
    })).rejects.toMatchObject({ code: "cash_out_transaction_failed" });

    mocks.readSolanaRpc.mockResolvedValueOnce(null);
    await expect(verifyFinalizedCashOutTransaction({
      kind: "confidential_withdrawal", signature: SIGNATURE,
      amountBaseUnits: AMOUNT.toString(), walletAddress: WALLET,
      tokenAccountAddress: TOKEN_ACCOUNT, wrappedMint: WRAPPED_MINT,
      circleMint: null, tokenWrapProgramId: WRAP_PROGRAM
    })).rejects.toMatchObject({ code: "cash_out_transaction_not_finalized" });
  });

  it("checks the exact Token Wrap instruction and both public token deltas for unwrap", async () => {
    const instructionData = Uint8Array.from([9, 8, 7, 6]);
    const instructionAccounts = [
      WRAP_ESCROW, CIRCLE_ACCOUNT, WRAP_AUTHORITY, CIRCLE_MINT,
      TOKEN_2022, TOKEN_PROGRAM, TOKEN_ACCOUNT, WRAPPED_MINT, WALLET
    ];
    mocks.buildWrappedUsdcUnwrapPlan.mockResolvedValue({
      plan: {
        kind: "sequential",
        plans: [
          { kind: "single", instruction: { programAddress: TOKEN_PROGRAM, accounts: [], data: Uint8Array.of(1) } },
          { kind: "single", instruction: {
            programAddress: WRAP_PROGRAM,
            accounts: instructionAccounts.map((entry) => ({ address: entry })),
            data: instructionData
          } }
        ]
      },
      sourceTokenAccount: TOKEN_ACCOUNT,
      destinationTokenAccount: CIRCLE_ACCOUNT,
      wrappedMintAuthority: WRAP_AUTHORITY,
      unwrappedEscrow: WRAP_ESCROW,
      expectedWrappedMintAddress: WRAPPED_MINT
    });
    mocks.readSolanaRpc.mockResolvedValue(tx([{
      programId: WRAP_PROGRAM,
      accounts: instructionAccounts,
      data: encodeBase58(instructionData)
    }], {
      err: null,
      preTokenBalances: [
        tokenBalance(1, WRAPPED_MINT, "2250000"),
        tokenBalance(2, CIRCLE_MINT, "100000", WALLET, TOKEN_PROGRAM)
      ],
      postTokenBalances: [
        tokenBalance(1, WRAPPED_MINT, "1000000"),
        tokenBalance(2, CIRCLE_MINT, "1350000", WALLET, TOKEN_PROGRAM)
      ]
    }, [WALLET, TOKEN_ACCOUNT, CIRCLE_ACCOUNT, WRAPPED_MINT, CIRCLE_MINT]));

    await expect(verifyFinalizedCashOutTransaction({
      kind: "circle_usdc_unwrap", signature: SIGNATURE,
      amountBaseUnits: AMOUNT.toString(), walletAddress: WALLET,
      tokenAccountAddress: TOKEN_ACCOUNT, wrappedMint: WRAPPED_MINT,
      circleMint: CIRCLE_MINT, tokenWrapProgramId: WRAP_PROGRAM
    })).resolves.toEqual({
      amountBaseUnits: AMOUNT.toString(),
      mint: CIRCLE_MINT,
      sourceTokenAccount: TOKEN_ACCOUNT,
      destinationTokenAccount: CIRCLE_ACCOUNT
    });
  });

  it("does not record an unwrap if its transaction differs from the prepared ABI", async () => {
    mocks.buildWrappedUsdcUnwrapPlan.mockResolvedValue({
      plan: {
        kind: "sequential",
        plans: [
          { kind: "single", instruction: { programAddress: WRAP_PROGRAM, accounts: [{ address: "expected" }], data: Uint8Array.of(1, 2) } }
        ]
      },
      sourceTokenAccount: TOKEN_ACCOUNT,
      destinationTokenAccount: CIRCLE_ACCOUNT
    });
    mocks.readSolanaRpc.mockResolvedValue(tx([{
      programId: WRAP_PROGRAM, accounts: ["different"], data: encodeBase58(Uint8Array.of(1, 3))
    }], { err: null }, [WALLET, TOKEN_ACCOUNT, CIRCLE_ACCOUNT]));
    await expect(verifyFinalizedCashOutTransaction({
      kind: "circle_usdc_unwrap", signature: SIGNATURE,
      amountBaseUnits: AMOUNT.toString(), walletAddress: WALLET,
      tokenAccountAddress: TOKEN_ACCOUNT, wrappedMint: WRAPPED_MINT,
      circleMint: CIRCLE_MINT, tokenWrapProgramId: WRAP_PROGRAM
    })).rejects.toMatchObject({ code: "cash_out_unwrap_instruction_not_verified" });
  });
});
