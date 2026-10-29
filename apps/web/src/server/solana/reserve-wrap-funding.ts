import "server-only";

import { address, createSolanaRpc, fetchEncodedAccount } from "@solana/kit";
import {
  fetchMint, fetchToken, TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS
} from "@solana-program/token-2022";
import {
  getWorkspaceConfidentialReserveSnapshot,
  WorkspaceReserveInitializationError
} from "./workspace-reserve";
import { buildWrappedUsdcWrapPlan } from "../../components/workspace/token-wrap-transaction";
import {
  assertDevnetTokenWrapIdentity, assertDevnetTokenWrapProgramAccount,
  DEVNET_TOKEN_WRAP_EXPECTED
} from "../../components/workspace/token-wrap-compatibility";
import { loadPayloreConfig } from "../config";
import { readSolanaRpc } from "./rpc";

const U64_MAX_P4 = (1n << 64n) - 1n;

type TokenBalanceP4 = {
  accountIndex?: unknown;
  mint?: unknown;
  owner?: unknown;
  programId?: unknown;
  uiTokenAmount?: { amount?: unknown; decimals?: unknown } | null;
};
type FinalizedMetaP4 = {
  err?: unknown;
  preTokenBalances?: TokenBalanceP4[] | null;
  postTokenBalances?: TokenBalanceP4[] | null;
  loadedAddresses?: { writable?: unknown[]; readonly?: unknown[] } | null;
};
type FinalizedTransactionP4 = {
  slot?: unknown;
  meta?: FinalizedMetaP4 | null;
  transaction?: {
    signatures?: unknown;
    message?: {
      header?: { numRequiredSignatures?: unknown } | null;
      accountKeys?: unknown;
      instructions?: unknown;
    } | null;
  } | null;
} | null;
type RpcInstructionP4 = { programId?: unknown; programIdIndex?: unknown; accounts?: unknown; data?: unknown };

export class ReserveWrapFundingError extends Error {
  constructor(readonly code: string, readonly statusCode: number) {
    super(code);
    this.name = "ReserveWrapFundingError";
  }
}

function objectP4(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

function rpcEndpointP4(): string {
  const config = loadPayloreConfig();
  const url = new URL(config.PAYLORE_RPC_PRIMARY_URL || "https://api.devnet.solana.com");
  if (url.protocol !== "https:" ||
      (!/devnet/i.test(url.hostname) && url.hostname !== "api.devnet.solana.com")) {
    throw new ReserveWrapFundingError("reserve_wrap_devnet_rpc_required", 503);
  }
  if (config.PAYLORE_RPC_PRIMARY_PROVIDER === "helius" && config.PAYLORE_RPC_PRIMARY_API_KEY) {
    url.searchParams.set("api-key", config.PAYLORE_RPC_PRIMARY_API_KEY);
  }
  return url.toString();
}

function positiveAmountP4(value: string): bigint {
  if (!/^[1-9][0-9]{0,19}$/.test(value)) {
    throw new ReserveWrapFundingError("reserve_wrap_amount_invalid", 400);
  }
  const amount = BigInt(value);
  if (amount > U64_MAX_P4) throw new ReserveWrapFundingError("reserve_wrap_amount_invalid", 400);
  return amount;
}

type PreparedContextP4 = {
  walletAddress: string;
  reserveAddress: string;
  reserveTokenAccountAddress: string;
  wrappedMintAddress: string;
  unwrappedMintAddress: string;
  tokenWrapProgramAddress: string;
  sourceTokenAccountAddress: string;
  wrappedMintAuthorityAddress: string;
  unwrappedEscrowAddress: string;
  amountBaseUnits: string;
  sourceBalanceBaseUnits: string;
};

async function resolveVerifiedContextP4(input: {
  db: Parameters<typeof getWorkspaceConfidentialReserveSnapshot>[0];
  workspaceId: string;
  walletAddress: string;
  amountBaseUnits: string;
  requireSufficientSourceBalance: boolean;
}): Promise<{
  prepared: PreparedContextP4;
  plan: Awaited<ReturnType<typeof buildWrappedUsdcWrapPlan>>;
}> {
  const amount = positiveAmountP4(input.amountBaseUnits);
  try {
    const config = loadPayloreConfig();
    if (config.PAYLORE_NETWORK !== "devnet" ||
        config.TOKEN_WRAP_PROGRAM_ID !== DEVNET_TOKEN_WRAP_EXPECTED.programAddress ||
        config.PAYLORE_WRAPPED_USDC_MINT !== DEVNET_TOKEN_WRAP_EXPECTED.wrappedMintAddress) {
      throw new ReserveWrapFundingError("reserve_wrap_identity_mismatch", 409);
    }
    const snapshot = await getWorkspaceConfidentialReserveSnapshot(
      input.db, input.workspaceId, input.walletAddress
    );
    if (snapshot.status !== "program_configured" ||
        snapshot.confidentialTransferReady !== true ||
        !snapshot.reserveAddress || !snapshot.tokenAccount) {
      throw new ReserveWrapFundingError("reserve_confidential_account_not_ready", 409);
    }

    const rpc = createSolanaRpc(rpcEndpointP4());
    const tokenWrapProgramAddress = config.TOKEN_WRAP_PROGRAM_ID;
    const wrappedMintAddress = config.PAYLORE_WRAPPED_USDC_MINT;
    const unwrappedMintAddress = DEVNET_TOKEN_WRAP_EXPECTED.unwrappedMintAddress;
    const [programAccount, wrappedMintAccount, unwrappedMintAccount] = await Promise.all([
      fetchEncodedAccount(rpc, address(tokenWrapProgramAddress)),
      fetchEncodedAccount(rpc, address(wrappedMintAddress)),
      fetchEncodedAccount(rpc, address(unwrappedMintAddress))
    ]);
    try {
      assertDevnetTokenWrapProgramAccount({
        programAddress: tokenWrapProgramAddress,
        ownerProgramAddress: programAccount.exists ? programAccount.programAddress : "",
        executable: programAccount.exists && programAccount.executable === true
      });
    } catch {
      throw new ReserveWrapFundingError("reserve_wrap_program_unavailable", 503);
    }
    if (!wrappedMintAccount.exists ||
        wrappedMintAccount.programAddress !== TOKEN_2022_PROGRAM_ADDRESS ||
        !unwrappedMintAccount.exists ||
        unwrappedMintAccount.programAddress !== TOKEN_PROGRAM_ADDRESS) {
      throw new ReserveWrapFundingError("reserve_wrap_mint_program_mismatch", 409);
    }

    const [wrappedMintData, unwrappedMintData] = await Promise.all([
      fetchMint(rpc, address(wrappedMintAddress)),
      fetchMint(rpc, address(unwrappedMintAddress))
    ]);
    let plan: Awaited<ReturnType<typeof buildWrappedUsdcWrapPlan>>;
    try {
      plan = await buildWrappedUsdcWrapPlan({
        ownerAddress: input.walletAddress,
        reserveAddress: snapshot.reserveAddress,
        reserveTokenAccountAddress: snapshot.tokenAccount,
        wrappedMintAddress,
        unwrappedMintAddress,
        tokenWrapProgramAddress,
        amount
      });
      assertDevnetTokenWrapIdentity({
        programAddress: tokenWrapProgramAddress,
        wrappedMintAddress,
        unwrappedMintAddress,
        wrappedMintProgramAddress: wrappedMintAccount.programAddress,
        unwrappedMintProgramAddress: unwrappedMintAccount.programAddress,
        derivedWrappedMintAddress: plan.expectedWrappedMintAddress,
        wrappedMintDecimals: wrappedMintData.data.decimals,
        unwrappedMintDecimals: unwrappedMintData.data.decimals
      });
    } catch {
      throw new ReserveWrapFundingError("reserve_wrap_identity_mismatch", 409);
    }

    const [sourceEncoded, destinationEncoded] = await Promise.all([
      fetchEncodedAccount(rpc, address(plan.sourceTokenAccount)),
      fetchEncodedAccount(rpc, address(plan.destinationTokenAccount))
    ]);
    if (!sourceEncoded.exists) throw new ReserveWrapFundingError("reserve_wrap_source_usdc_missing", 409);
    if (sourceEncoded.programAddress !== TOKEN_PROGRAM_ADDRESS) {
      throw new ReserveWrapFundingError("reserve_wrap_source_account_mismatch", 409);
    }
    if (!destinationEncoded.exists ||
        destinationEncoded.programAddress !== TOKEN_2022_PROGRAM_ADDRESS) {
      throw new ReserveWrapFundingError("reserve_wrap_destination_account_mismatch", 409);
    }

    const [sourceToken, destinationToken, escrowEncoded] = await Promise.all([
      fetchToken(rpc, address(plan.sourceTokenAccount)),
      fetchToken(rpc, address(plan.destinationTokenAccount)),
      fetchEncodedAccount(rpc, address(plan.unwrappedEscrow))
    ]);
    if (sourceToken.data.owner !== input.walletAddress ||
        sourceToken.data.mint !== unwrappedMintAddress) {
      throw new ReserveWrapFundingError("reserve_wrap_source_account_mismatch", 409);
    }
    if (destinationToken.data.owner !== snapshot.reserveAddress ||
        destinationToken.data.mint !== wrappedMintAddress) {
      throw new ReserveWrapFundingError("reserve_wrap_destination_account_mismatch", 409);
    }
    if (escrowEncoded.exists) {
      if (escrowEncoded.programAddress !== TOKEN_PROGRAM_ADDRESS) {
        throw new ReserveWrapFundingError("reserve_wrap_escrow_account_mismatch", 409);
      }
      const escrow = await fetchToken(rpc, address(plan.unwrappedEscrow));
      if (escrow.data.owner !== plan.wrappedMintAuthority ||
          escrow.data.mint !== unwrappedMintAddress) {
        throw new ReserveWrapFundingError("reserve_wrap_escrow_account_mismatch", 409);
      }
    }
    const sourceBalance = BigInt(sourceToken.data.amount);
    if (input.requireSufficientSourceBalance && sourceBalance < amount) {
      throw new ReserveWrapFundingError("reserve_wrap_source_usdc_insufficient", 409);
    }
    return {
      prepared: {
        walletAddress: input.walletAddress,
        reserveAddress: snapshot.reserveAddress,
        reserveTokenAccountAddress: plan.destinationTokenAccount,
        wrappedMintAddress,
        unwrappedMintAddress,
        tokenWrapProgramAddress,
        sourceTokenAccountAddress: plan.sourceTokenAccount,
        wrappedMintAuthorityAddress: plan.wrappedMintAuthority,
        unwrappedEscrowAddress: plan.unwrappedEscrow,
        amountBaseUnits: amount.toString(),
        sourceBalanceBaseUnits: sourceBalance.toString()
      },
      plan
    };
  } catch (error) {
    if (error instanceof ReserveWrapFundingError) throw error;
    if (error instanceof WorkspaceReserveInitializationError) {
      throw new ReserveWrapFundingError(error.code, error.statusCode);
    }
    throw new ReserveWrapFundingError("reserve_wrap_preflight_unavailable", 503);
  }
}

export async function prepareReserveWrapFunding(input: {
  db: Parameters<typeof getWorkspaceConfidentialReserveSnapshot>[0];
  workspaceId: string;
  walletAddress: string;
  amountBaseUnits: string;
}): Promise<PreparedContextP4 & { status: "prepared" }> {
  const resolved = await resolveVerifiedContextP4({ ...input, requireSufficientSourceBalance: true });
  return { status: "prepared", ...resolved.prepared };
}

function keyStringP4(value: unknown): string {
  if (typeof value === "string") return value;
  const row = objectP4(value);
  return typeof row?.pubkey === "string" ? row.pubkey : "";
}
function keysOfP4(value: unknown): string[] {
  return Array.isArray(value) ? value.map(keyStringP4) : [];
}
function allKeysOfP4(message: Record<string, unknown>, meta: FinalizedMetaP4): string[] {
  const loaded = objectP4(meta.loadedAddresses);
  return [...keysOfP4(message.accountKeys), ...keysOfP4(loaded?.writable), ...keysOfP4(loaded?.readonly)];
}
function instructionProgramP4(instruction: RpcInstructionP4, keys: string[]): string {
  if (typeof instruction.programId === "string") return instruction.programId;
  return typeof instruction.programIdIndex === "number" ? keys[instruction.programIdIndex] ?? "" : "";
}
function instructionAccountsP4(instruction: RpcInstructionP4, keys: string[]): string[] {
  if (!Array.isArray(instruction.accounts)) return [];
  return instruction.accounts.map(entry =>
    typeof entry === "string" ? entry :
      typeof entry === "number" ? keys[entry] ?? "" : ""
  );
}
function decodeBase58P4(value: string): Uint8Array | null {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = 0n;
  for (const character of value) {
    const digit = alphabet.indexOf(character);
    if (digit < 0) return null;
    number = number * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (number > 0n) { bytes.unshift(Number(number & 0xffn)); number >>= 8n; }
  for (const character of value) { if (character !== "1") break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}
function equalBytesP4(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
function balanceP4(
  records: TokenBalanceP4[] | null | undefined,
  accountIndex: number,
  mint: string,
  owner: string,
  tokenProgram: string,
  allowMissing: boolean
): bigint {
  const rows = (records ?? []).filter(row => row.accountIndex === accountIndex);
  if (rows.length === 0 && allowMissing) return 0n;
  if (rows.length !== 1) throw new ReserveWrapFundingError("reserve_wrap_token_balance_not_verified", 409);
  const row = rows[0];
  const rawAmount = row.uiTokenAmount?.amount;
  if (row.mint !== mint || row.owner !== owner ||
      (row.programId !== undefined && row.programId !== tokenProgram) ||
      typeof rawAmount !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(rawAmount) ||
      row.uiTokenAmount?.decimals !== DEVNET_TOKEN_WRAP_EXPECTED.decimals) {
    throw new ReserveWrapFundingError("reserve_wrap_token_account_identity_mismatch", 409);
  }
  return BigInt(rawAmount);
}
function tokenBalanceDeltaP4(
  meta: FinalizedMetaP4,
  accountIndex: number,
  mint: string,
  owner: string,
  program: string,
  direction: "credit" | "debit",
  allowMissingBefore = false
): bigint {
  const before = balanceP4(meta.preTokenBalances, accountIndex, mint, owner, program, allowMissingBefore);
  const after = balanceP4(meta.postTokenBalances, accountIndex, mint, owner, program, false);
  const delta = direction === "credit" ? after - before : before - after;
  if (delta < 0n) throw new ReserveWrapFundingError("reserve_wrap_balance_delta_invalid", 409);
  return delta;
}

export function assertExactReserveWrapTokenBalanceDeltas(input: {
  amountBaseUnits: bigint;
  sourceDebitBaseUnits: bigint;
  escrowCreditBaseUnits: bigint;
  destinationCreditBaseUnits: bigint;
}): void {
  if (input.amountBaseUnits <= 0n || input.amountBaseUnits > U64_MAX_P4 ||
      input.sourceDebitBaseUnits !== input.amountBaseUnits ||
      input.escrowCreditBaseUnits !== input.amountBaseUnits ||
      input.destinationCreditBaseUnits !== input.amountBaseUnits) {
    throw new ReserveWrapFundingError("reserve_wrap_balance_delta_invalid", 409);
  }
}

export async function verifyFinalizedReserveWrapFunding(input: {
  db: Parameters<typeof getWorkspaceConfidentialReserveSnapshot>[0];
  workspaceId: string;
  walletAddress: string;
  amountBaseUnits: string;
  signature: string;
}): Promise<{
  status: "wrapped_public_balance_verified";
  signature: string;
  amountBaseUnits: string;
  sourceTokenAccount: string;
  escrowTokenAccount: string;
  destinationTokenAccount: string;
  slot: number;
}> {
  const resolved = await resolveVerifiedContextP4({
    db: input.db, workspaceId: input.workspaceId, walletAddress: input.walletAddress,
    amountBaseUnits: input.amountBaseUnits, requireSufficientSourceBalance: false
  });
  const amount = positiveAmountP4(input.amountBaseUnits);
  let transaction: FinalizedTransactionP4;
  try {
    transaction = await readSolanaRpc<FinalizedTransactionP4>("getTransaction", [
      input.signature, { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 }
    ]);
  } catch {
    throw new ReserveWrapFundingError("reserve_wrap_transaction_status_unavailable", 503);
  }
  const tx = objectP4(transaction);
  const meta = objectP4(tx?.meta) as FinalizedMetaP4 | null;
  const body = objectP4(tx?.transaction);
  const message = objectP4(body?.message);
  const signatures = body?.signatures;
  const instructionList = message?.instructions;
  if (!tx || !meta || typeof tx.slot !== "number" ||
      !Array.isArray(signatures) || !Array.isArray(instructionList) ||
      meta.err === undefined || !message) {
    throw new ReserveWrapFundingError("reserve_wrap_transaction_not_finalized", 202);
  }
  if (meta.err !== null) throw new ReserveWrapFundingError("reserve_wrap_transaction_failed", 409);
  if (!signatures.includes(input.signature)) throw new ReserveWrapFundingError("reserve_wrap_signature_mismatch", 409);
  const header = objectP4(message.header);
  const requiredSignatures = header?.numRequiredSignatures;
  const signedByWallet = Array.isArray(message.accountKeys) && message.accountKeys.some((entry, index) => {
    const row = objectP4(entry);
    const isSigner = typeof row?.signer === "boolean" ? row.signer :
      typeof requiredSignatures === "number" && index < requiredSignatures;
    return keyStringP4(entry) === input.walletAddress && isSigner;
  });
  if (!signedByWallet) throw new ReserveWrapFundingError("reserve_wrap_wallet_signature_missing", 409);

  const keys = allKeysOfP4(message, meta);
  const instructions = instructionList.filter((entry): entry is RpcInstructionP4 => objectP4(entry) !== null);
  const expectedPlan = resolved.plan.plan;
  if (expectedPlan.kind !== "sequential") throw new ReserveWrapFundingError("reserve_wrap_instruction_not_verified", 409);
  const expectedWrap = expectedPlan.plans.find(plan =>
    plan.kind === "single" && plan.instruction.programAddress === resolved.prepared.tokenWrapProgramAddress
  );
  if (!expectedWrap || expectedWrap.kind !== "single" || !expectedWrap.instruction.data) {
    throw new ReserveWrapFundingError("reserve_wrap_instruction_not_verified", 409);
  }
  const actualMatches = instructions.filter(instruction => {
    if (instructionProgramP4(instruction, keys) !== resolved.prepared.tokenWrapProgramAddress ||
        typeof instruction.data !== "string") return false;
    const data = decodeBase58P4(instruction.data);
    const expectedAccounts = (expectedWrap.instruction.accounts ?? []).map(account => account.address);
    const actualAccounts = instructionAccountsP4(instruction, keys);
    return data !== null &&
      equalBytesP4(data, Uint8Array.from(expectedWrap.instruction.data!)) &&
      actualAccounts.length === expectedAccounts.length &&
      actualAccounts.every((account, index) => account === expectedAccounts[index]);
  });
  if (actualMatches.length !== 1) throw new ReserveWrapFundingError("reserve_wrap_instruction_not_verified", 409);

  const sourceIndex = keys.indexOf(resolved.prepared.sourceTokenAccountAddress);
  const escrowIndex = keys.indexOf(resolved.prepared.unwrappedEscrowAddress);
  const destinationIndex = keys.indexOf(resolved.prepared.reserveTokenAccountAddress);
  if (sourceIndex < 0 || escrowIndex < 0 || destinationIndex < 0) {
    throw new ReserveWrapFundingError("reserve_wrap_token_account_identity_mismatch", 409);
  }
  assertExactReserveWrapTokenBalanceDeltas({
    amountBaseUnits: amount,
    sourceDebitBaseUnits: tokenBalanceDeltaP4(
      meta, sourceIndex, resolved.prepared.unwrappedMintAddress, input.walletAddress, TOKEN_PROGRAM_ADDRESS, "debit"
    ),
    escrowCreditBaseUnits: tokenBalanceDeltaP4(
      meta, escrowIndex, resolved.prepared.unwrappedMintAddress,
      resolved.prepared.wrappedMintAuthorityAddress, TOKEN_PROGRAM_ADDRESS, "credit", true
    ),
    destinationCreditBaseUnits: tokenBalanceDeltaP4(
      meta, destinationIndex, resolved.prepared.wrappedMintAddress,
      resolved.prepared.reserveAddress, TOKEN_2022_PROGRAM_ADDRESS, "credit"
    )
  });
  return {
    status: "wrapped_public_balance_verified",
    signature: input.signature,
    amountBaseUnits: amount.toString(),
    sourceTokenAccount: resolved.prepared.sourceTokenAccountAddress,
    escrowTokenAccount: resolved.prepared.unwrappedEscrowAddress,
    destinationTokenAccount: resolved.prepared.reserveTokenAccountAddress,
    slot: tx.slot
  };
}
