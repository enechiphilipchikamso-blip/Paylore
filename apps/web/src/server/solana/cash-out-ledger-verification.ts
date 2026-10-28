import "server-only";

import {
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS
} from "@solana-program/token-2022";
import { buildWrappedUsdcUnwrapPlan } from "../../components/workspace/token-wrap-transaction";
import { DEVNET_TOKEN_WRAP_EXPECTED } from "../../components/workspace/token-wrap-compatibility";
import { readSolanaRpc } from "./rpc";

const U64_MAX = (1n << 64n) - 1n;

type RpcInstruction = {
  programId?: unknown;
  programIdIndex?: unknown;
  accounts?: unknown;
  data?: unknown;
};
type TokenBalance = {
  accountIndex?: unknown;
  mint?: unknown;
  owner?: unknown;
  programId?: unknown;
  uiTokenAmount?: { amount?: unknown; decimals?: unknown } | null;
};
type FinalizedMeta = {
  err?: unknown;
  preTokenBalances?: TokenBalance[] | null;
  postTokenBalances?: TokenBalance[] | null;
};
type FinalizedTransaction = {
  slot?: unknown;
  meta?: FinalizedMeta | null;
  transaction?: {
    signatures?: unknown;
    message?: {
      header?: { numRequiredSignatures?: unknown } | null;
      accountKeys?: unknown;
      instructions?: unknown;
    } | null;
  } | null;
} | null;

export class CashOutLedgerVerificationError extends Error {
  constructor(readonly code: string, readonly statusCode: number) {
    super(code);
    this.name = "CashOutLedgerVerificationError";
  }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function keysOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => {
    if (typeof entry === "string") return entry;
    const key = object(entry)?.pubkey;
    return typeof key === "string" ? key : "";
  });
}

function decodeBase58(value: string): Uint8Array | null {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
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

function programOf(instruction: RpcInstruction, keys: string[]): string {
  if (typeof instruction.programId === "string") return instruction.programId;
  return typeof instruction.programIdIndex === "number"
    ? keys[instruction.programIdIndex] ?? ""
    : "";
}

function accountsOf(instruction: RpcInstruction, keys: string[]): string[] {
  if (!Array.isArray(instruction.accounts)) return [];
  return instruction.accounts.map((entry) =>
    typeof entry === "string" ? entry :
      typeof entry === "number" ? keys[entry] ?? "" : ""
  );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function positiveAmount(value: string): bigint {
  if (!/^[1-9][0-9]{0,19}$/.test(value)) {
    throw new CashOutLedgerVerificationError("cash_out_amount_invalid", 400);
  }
  const amount = BigInt(value);
  if (amount > U64_MAX) throw new CashOutLedgerVerificationError("cash_out_amount_invalid", 400);
  return amount;
}

function finalizedTransaction(
  transaction: FinalizedTransaction,
  signature: string,
  walletAddress: string
): { keys: string[]; instructions: RpcInstruction[]; meta: FinalizedMeta } {
  const tx = object(transaction);
  const meta = object(tx?.meta) as FinalizedMeta | null;
  const body = object(tx?.transaction);
  const message = object(body?.message);
  const signatures = body?.signatures;
  const keys = keysOf(message?.accountKeys);
  const instructions = message?.instructions;
  const header = object(message?.header);
  const requiredSignatures = header?.numRequiredSignatures;

  const signedByWallet = Array.isArray(message?.accountKeys) &&
    message!.accountKeys!.some((entry, index) => {
      const row = object(entry);
      const key = typeof entry === "string" ? entry : row?.pubkey;
      const signer = typeof row?.signer === "boolean"
        ? row.signer
        : typeof requiredSignatures === "number" && index < requiredSignatures;
      return key === walletAddress && signer;
    });

  if (!tx || !meta || typeof tx.slot !== "number" ||
      !Array.isArray(signatures) || !Array.isArray(instructions) || meta.err === undefined) {
    throw new CashOutLedgerVerificationError("cash_out_transaction_not_finalized", 409);
  }
  if (meta.err !== null) {
    throw new CashOutLedgerVerificationError("cash_out_transaction_failed", 409);
  }
  if (!signatures.includes(signature)) {
    throw new CashOutLedgerVerificationError("cash_out_transaction_signature_mismatch", 409);
  }
  if (!signedByWallet) {
    throw new CashOutLedgerVerificationError("cash_out_wallet_signature_missing", 409);
  }

  return {
    keys,
    instructions: instructions.filter((entry): entry is RpcInstruction => object(entry) !== null),
    meta
  };
}

function balance(
  records: TokenBalance[] | null | undefined,
  index: number,
  mint: string,
  owner: string,
  tokenProgram: string,
  allowMissing: boolean
): bigint {
  const matches = (records ?? []).filter((entry) => entry.accountIndex === index);
  if (matches.length === 0 && allowMissing) return 0n;
  if (matches.length !== 1) {
    throw new CashOutLedgerVerificationError("cash_out_token_balance_not_verified", 409);
  }
  const row = matches[0];
  const amount = row.uiTokenAmount?.amount;
  const decimals = row.uiTokenAmount?.decimals;
  if (row.mint !== mint || row.owner !== owner ||
      (row.programId !== undefined && row.programId !== tokenProgram) ||
      typeof amount !== "string" || !/^(0|[1-9][0-9]*)$/.test(amount) ||
      decimals !== DEVNET_TOKEN_WRAP_EXPECTED.decimals) {
    throw new CashOutLedgerVerificationError("cash_out_token_account_identity_mismatch", 409);
  }
  return BigInt(amount);
}

function tokenBalanceDelta(
  meta: FinalizedMeta,
  accountIndex: number,
  mint: string,
  owner: string,
  program: string,
  deltaDirection: "credit" | "debit",
  allowMissingBefore = false
): bigint {
  const before = balance(meta.preTokenBalances, accountIndex, mint, owner, program, allowMissingBefore);
  const after = balance(meta.postTokenBalances, accountIndex, mint, owner, program, false);
  const delta = deltaDirection === "credit" ? after - before : before - after;
  if (delta < 0n) throw new CashOutLedgerVerificationError("cash_out_balance_delta_invalid", 409);
  return delta;
}

/** Reconciles public token deltas and the exact finalized instruction without decrypting confidential ciphertext. */
export async function verifyFinalizedCashOutTransaction(input: {
  kind: "confidential_withdrawal" | "circle_usdc_unwrap";
  signature: string;
  amountBaseUnits: string;
  walletAddress: string;
  tokenAccountAddress: string;
  wrappedMint: string;
  circleMint: string | null;
  tokenWrapProgramId: string;
}): Promise<{
  amountBaseUnits: string;
  mint: string;
  sourceTokenAccount: string;
  destinationTokenAccount: string;
}> {
  const amount = positiveAmount(input.amountBaseUnits);
  const transaction = await readSolanaRpc<FinalizedTransaction>("getTransaction", [
    input.signature,
    { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 }
  ]);
  if (!transaction) {
    throw new CashOutLedgerVerificationError("cash_out_transaction_not_finalized", 409);
  }
  const parsed = finalizedTransaction(transaction, input.signature, input.walletAddress);
  const instructions = parsed.instructions;
  const keys = parsed.keys;

  if (input.kind === "confidential_withdrawal") {
    const tokenIndex = keys.indexOf(input.tokenAccountAddress);
    if (tokenIndex < 0 || input.circleMint !== null) {
      throw new CashOutLedgerVerificationError("cash_out_token_account_identity_mismatch", 409);
    }
    const matches = instructions.filter((instruction) => {
      const data = typeof instruction.data === "string" ? decodeBase58(instruction.data) : null;
      const accounts = accountsOf(instruction, keys);
      if (programOf(instruction, keys) !== TOKEN_2022_PROGRAM_ADDRESS ||
          !data || data.length < 11 || data[0] !== 27 || data[1] !== 6 ||
          accounts.length < 6 ||
          accounts[0] !== input.tokenAccountAddress ||
          accounts[1] !== input.wrappedMint ||
          accounts[5] !== input.walletAddress ||
          data[10] !== DEVNET_TOKEN_WRAP_EXPECTED.decimals) return false;
      let instructionAmount = 0n;
      for (let index = 0; index < 8; index++) {
        instructionAmount |= BigInt(data[2 + index]) << BigInt(index * 8);
      }
      return instructionAmount === amount;
    });
    if (matches.length !== 1) {
      throw new CashOutLedgerVerificationError("cash_out_withdraw_instruction_not_verified", 409);
    }

    const credited = tokenBalanceDelta(
      parsed.meta, tokenIndex, input.wrappedMint, input.walletAddress,
      TOKEN_2022_PROGRAM_ADDRESS, "credit"
    );
    if (credited !== amount) {
      throw new CashOutLedgerVerificationError("cash_out_balance_delta_invalid", 409);
    }
    return {
      amountBaseUnits: amount.toString(),
      mint: input.wrappedMint,
      sourceTokenAccount: input.tokenAccountAddress,
      destinationTokenAccount: input.tokenAccountAddress
    };
  }

  if (!input.circleMint ||
      input.tokenWrapProgramId !== DEVNET_TOKEN_WRAP_EXPECTED.programAddress ||
      input.wrappedMint !== DEVNET_TOKEN_WRAP_EXPECTED.wrappedMintAddress ||
      input.circleMint !== DEVNET_TOKEN_WRAP_EXPECTED.unwrappedMintAddress) {
    throw new CashOutLedgerVerificationError("cash_out_token_wrap_identity_mismatch", 409);
  }

  let expected: Awaited<ReturnType<typeof buildWrappedUsdcUnwrapPlan>>;
  try {
    expected = await buildWrappedUsdcUnwrapPlan({
      ownerAddress: input.walletAddress,
      wrappedMintAddress: input.wrappedMint,
      unwrappedMintAddress: input.circleMint,
      tokenWrapProgramAddress: input.tokenWrapProgramId,
      amount
    });
  } catch {
    throw new CashOutLedgerVerificationError("cash_out_token_wrap_plan_not_verified", 409);
  }
  if (expected.plan.kind !== "sequential") {
    throw new CashOutLedgerVerificationError("cash_out_token_wrap_plan_not_verified", 409);
  }
  const expectedInstruction = expected.plan.plans.find((plan) =>
    plan.kind === "single" && plan.instruction.programAddress === input.tokenWrapProgramId
  );
  if (!expectedInstruction || expectedInstruction.kind !== "single") {
    throw new CashOutLedgerVerificationError("cash_out_token_wrap_plan_not_verified", 409);
  }
  const expectedInstructionData = expectedInstruction.instruction.data;
  if (!expectedInstructionData) {
    throw new CashOutLedgerVerificationError("cash_out_token_wrap_plan_not_verified", 409);
  }

  const actualMatches = instructions.filter((instruction) => {
    if (programOf(instruction, keys) !== input.tokenWrapProgramId ||
        typeof instruction.data !== "string") return false;
    const data = decodeBase58(instruction.data);
    const expectedAccounts = (expectedInstruction.instruction.accounts ?? []).map((entry) => entry.address);
    const actualAccounts = accountsOf(instruction, keys);
    return data !== null && equalBytes(
      data,
      Uint8Array.from(expectedInstructionData)
    ) &&
      actualAccounts.length === expectedAccounts.length &&
      actualAccounts.every((account, index) => account === expectedAccounts[index]);
  });
  if (actualMatches.length !== 1) {
    throw new CashOutLedgerVerificationError("cash_out_unwrap_instruction_not_verified", 409);
  }

  const sourceIndex = keys.indexOf(expected.sourceTokenAccount);
  const destinationIndex = keys.indexOf(expected.destinationTokenAccount);
  if (sourceIndex < 0 || destinationIndex < 0) {
    throw new CashOutLedgerVerificationError("cash_out_token_account_identity_mismatch", 409);
  }
  const debited = tokenBalanceDelta(
    parsed.meta, sourceIndex, input.wrappedMint, input.walletAddress,
    TOKEN_2022_PROGRAM_ADDRESS, "debit"
  );
  const credited = tokenBalanceDelta(
    parsed.meta, destinationIndex, input.circleMint, input.walletAddress,
    TOKEN_PROGRAM_ADDRESS, "credit", true
  );
  if (debited !== amount || credited !== amount) {
    throw new CashOutLedgerVerificationError("cash_out_balance_delta_invalid", 409);
  }
  return {
    amountBaseUnits: amount.toString(),
    mint: input.circleMint,
    sourceTokenAccount: expected.sourceTokenAccount,
    destinationTokenAccount: expected.destinationTokenAccount
  };
}
