import "server-only";

import { createHash } from "node:crypto";
import {
  AccountRole, addSignersToTransactionMessage, address, appendTransactionMessageInstruction, blockhash, createKeyPairSignerFromBytes, createSolanaRpc,
  createTransactionMessage, createTransactionPlanExecutorWithConcurrentLeaves,
  createTransactionPlanner, fetchEncodedAccount, getAddressEncoder,
  getBase64EncodedWireTransaction, getBase58Decoder, getProgramDerivedAddress,
  partiallySignTransactionMessageWithSigners, setTransactionMessageFeePayerSigner, signature,
  setTransactionMessageLifetimeUsingBlockhash, singleInstructionPlan,
  type Instruction, type InstructionPlan, type Signature
} from "@solana/kit";
import {
  fetchMint, fetchToken, findAssociatedTokenPda, getConfidentialDepositInstruction, TOKEN_2022_PROGRAM_ADDRESS
} from "@solana-program/token-2022";
import {
  deriveConfidentialKeys, fetchConfidentialTransferBalance,
  getApplyConfidentialPendingBalanceInstructionFromToken,
  getCreateConfidentialTransferAccountInstructionPlan
} from "@solana-program/token-2022/confidential";
import { AeKey, ElGamalKeypair, ElGamalSecretKey } from "@solana/zk-sdk/bundler";
import {
  attachWorkspaceReserveSetupSignature, clearWorkspaceReserveSetupSignature,
  advanceWorkspaceReserveFundingOperation, beginWorkspaceReserveFundingOperation,
  getWorkspaceGasTank, getWorkspacePayrollProgramAuthority, getWorkspaceReserve,
  type Database, type ReserveFundingOperationStage
} from "@paylore/database";
import { loadPayloreConfig } from "../config";
import { withWorkspaceGasTankKey } from "../gas-tank";
import { withWorkspaceReserveKey } from "../reserve";
import {
  classifyReserveFundingState, hasApprovedConfidentialTransferAccount, verifyWorkspaceProgramState,
  type ReserveFundingState
} from "./workspace-reserve-policy";
import { classifyTransactionFinality } from "./payroll-confidential-settlement-policy";
import { readSolanaRpc } from "./rpc";

const DEVNET_RPC_URL = "https://api.devnet.solana.com";
const FINALITY_TIMEOUT_MS = 120_000;
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const encoder = new TextEncoder();

type Token = Awaited<ReturnType<typeof fetchToken>>["data"];
type Mint = Awaited<ReturnType<typeof fetchMint>>["data"];
type KeyPairSigner = Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>;
const TOKEN_ACCOUNT_RENT_PREFLIGHT_SIZE = 1024n;
const RESERVE_STATE_RENT_SIZE = 137n;
const RESERVE_SETUP_FEE_BUFFER_LAMPORTS = 50_000n;
type WorkspaceReservePhase = "account_setup" | "program_configure";

export type WorkspaceConfidentialReserveResult = {
  status:
    | "confidential_account_ready"
    | "program_configured"
    | "workspace_program_not_initialized"
    | "account_missing"
    | "no_reserve"
    | "not_configured"
    | "pending"
    | "retry_ready";
  reserveAddress?: string;
  tokenAccount?: string | null;
  confidentialTransferReady?: boolean;
  publicBalanceBaseUnits?: string;
  availableBalanceBaseUnits?: string;
  pendingBalanceBaseUnits?: string;
  fundingState?: ReserveFundingState;
  programReserveConfigured?: boolean;
  signature?: string;
  phase?: WorkspaceReservePhase;
};

export class WorkspaceReserveInitializationError extends Error {
  constructor(readonly code: string, readonly statusCode: number) {
    super(code);
    this.name = "WorkspaceReserveInitializationError";
  }
}

class FinalityPendingError extends Error {
  constructor(readonly signature: string) { super("The transaction is awaiting finality."); }
}
class FinalityFailedError extends Error {
  constructor(readonly signature: string) { super("The transaction failed at finality."); }
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}
function discriminator(name: string): Uint8Array {
  return createHash("sha256").update(name).digest().subarray(0, 8);
}
function extensions(value: Token | Mint): readonly { __kind: string; [key: string]: unknown }[] {
  const raw = value.extensions as unknown;
  if (raw && typeof raw === "object" && "value" in raw) {
    const inner = (raw as { value?: unknown }).value;
    return Array.isArray(inner) ? inner as readonly { __kind: string; [key: string]: unknown }[] : [];
  }
  return Array.isArray(raw) ? raw as readonly { __kind: string; [key: string]: unknown }[] : [];
}
function rpcEndpoint(): string {
  const config = loadPayloreConfig();
  const url = new URL(config.PAYLORE_RPC_PRIMARY_URL || DEVNET_RPC_URL);
  if (url.protocol !== "https:") {
    throw new WorkspaceReserveInitializationError("reserve_devnet_rpc_required", 503);
  }
  if (config.PAYLORE_RPC_PRIMARY_PROVIDER === "helius" && config.PAYLORE_RPC_PRIMARY_API_KEY) {
    url.searchParams.set("api-key", config.PAYLORE_RPC_PRIMARY_API_KEY);
  }
  if (!/devnet/i.test(url.hostname) && url.hostname !== "api.devnet.solana.com") {
    throw new WorkspaceReserveInitializationError("reserve_devnet_rpc_required", 503);
  }
  return url.toString();
}
async function waitForFinality(
  rpc: ReturnType<typeof createSolanaRpc>,
  signature: Signature
): Promise<"finalized" | "failed" | "pending"> {
  const deadline = Date.now() + FINALITY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const status = (await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send()).value[0];
      const finality = classifyTransactionFinality(status);
      if (finality !== "pending") return finality;
    } catch {
      // A provider error does not establish that a submitted transaction failed.
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return "pending";
}

function encodeReserveBase58(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let number = 0n;
  for (const byte of bytes) number = number * 256n + BigInt(byte);
  let result = "";
  while (number > 0n) {
    result = alphabet[Number(number % 58n)] + result;
    number /= 58n;
  }
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes++;
  return "1".repeat(leadingZeroes) + result;
}

function reserveSignatureFromWireTransaction(wire: string): string {
  const bytes = Buffer.from(wire, "base64");
  let offset = 0;
  let signatureCount = 0;
  let shift = 0;
  while (offset < bytes.length && shift < 21) {
    const value = bytes[offset++];
    signatureCount |= (value & 0x7f) << shift;
    if ((value & 0x80) === 0) break;
    shift += 7;
  }
  if (signatureCount < 1 || bytes.length < offset + 64) {
    throw new WorkspaceReserveInitializationError("reserve_confidential_funding_signature_unavailable", 503);
  }
  return encodeReserveBase58(Uint8Array.from(bytes.subarray(offset, offset + 64)));
}

async function executePlan(
  rpc: ReturnType<typeof createSolanaRpc>,
  feePayerSigner: KeyPairSigner,
  plan: InstructionPlan,
  submitted?: (signature: string) => Promise<void>,
  additionalSigners: readonly KeyPairSigner[] = [],
  memo?: string,
  prepared?: (signature: string, lastValidBlockHeight: string) => Promise<void>
): Promise<{ successful: boolean; pending: boolean; signatures: string[]; trackingFailed: boolean }> {
  let currentLastValidBlockHeight: bigint | null = null;
  const planner = createTransactionPlanner({
    createTransactionMessage: () =>
      setTransactionMessageFeePayerSigner(feePayerSigner, createTransactionMessage({ version: 0 })),
    onTransactionMessageUpdated: async (message) => {
      const latest = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
      currentLastValidBlockHeight = BigInt(latest.value.lastValidBlockHeight);
      return setTransactionMessageLifetimeUsingBlockhash({
        blockhash: blockhash(latest.value.blockhash),
        lastValidBlockHeight: currentLastValidBlockHeight
      }, message);
    }
  });
  const planned = await planner(plan);
  const signatures: string[] = [];
  let trackingFailed = false;
  const executor = createTransactionPlanExecutorWithConcurrentLeaves({
    executeTransactionMessage: async (_context, message) => {
      const messageWithMemo = memo
        ? appendTransactionMessageInstruction({
            programAddress: address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr"),
            accounts: [],
            data: encoder.encode(memo)
          }, message)
        : message;
      const messageWithSigners = addSignersToTransactionMessage(
        [feePayerSigner, ...additionalSigners],
        messageWithMemo
      );
      const signed = await partiallySignTransactionMessageWithSigners(messageWithSigners);
      const wire = getBase64EncodedWireTransaction(signed);
      const expectedSignature = reserveSignatureFromWireTransaction(wire);
      if (prepared) {
        if (currentLastValidBlockHeight === null) {
          throw new WorkspaceReserveInitializationError("reserve_confidential_funding_blockhash_unavailable", 503);
        }
        await prepared(expectedSignature, currentLastValidBlockHeight.toString());
      }
      const signature = await rpc.sendTransaction(wire, {
        encoding: "base64", preflightCommitment: "confirmed", maxRetries: 3n
      }).send();
      const signatureText = String(signature);
      if (signatureText !== expectedSignature) {
        throw new WorkspaceReserveInitializationError("reserve_confidential_funding_signature_mismatch", 409);
      }
      signatures.push(signatureText);
      if (submitted) {
        try {
          await submitted(signatureText);
        } catch {
          trackingFailed = true;
        }
      }
      const finality = await waitForFinality(rpc, signature);
      if (finality === "pending") throw new FinalityPendingError(signatureText);
      if (finality === "failed") throw new FinalityFailedError(signatureText);
      return { signature };
    }
  });
  try {
    await executor(planned);
    return { successful: !trackingFailed, pending: false, signatures, trackingFailed };
  } catch (error) {
    if (error instanceof FinalityPendingError) return { successful: false, pending: true, signatures, trackingFailed };
    if (error instanceof FinalityFailedError) return { successful: false, pending: false, signatures, trackingFailed };
    if (/(insufficient funds|insufficient lamports|insufficient balance|insufficient fee|fee payer.{0,40}insufficient|attempt to debit an account but found no record of a prior credit)/i.test(
      error instanceof Error ? error.message : String(error)
    )) {
      throw new WorkspaceReserveInitializationError("reserve_gas_tank_insufficient_funds", 409);
    }
    throw error;
  }
}
async function verifyGasTankBalanceReadable(
  rpc: ReturnType<typeof createSolanaRpc>,
  gasTankAddress: string
): Promise<void> {
  try {
    const response = await rpc.getBalance(
      address(gasTankAddress),
      { commitment: "confirmed" }
    ).send();
    if (BigInt(response.value) < 0n) {
      throw new Error("The RPC returned a negative balance.");
    }
  } catch {
    throw new WorkspaceReserveInitializationError("reserve_gas_tank_balance_unavailable", 503);
  }
}

async function assertGasTankCanFundReserveSetup(input: {
  rpc: ReturnType<typeof createSolanaRpc>;
  gasTankAddress: string;
  needsTokenAccountRent: boolean;
  needsReserveStateRent: boolean;
  transactionCount: number;
}): Promise<void> {
  if (input.transactionCount === 0) return;
  try {
    const balanceResponse = await input.rpc.getBalance(
      address(input.gasTankAddress),
      { commitment: "confirmed" }
    ).send();
    const balance = BigInt(balanceResponse.value);
    if (balance < 0n) throw new Error("The RPC returned a negative balance.");

    let required = BigInt(input.transactionCount) * RESERVE_SETUP_FEE_BUFFER_LAMPORTS;
    if (input.needsTokenAccountRent) {
      required += BigInt(await input.rpc.getMinimumBalanceForRentExemption(
        TOKEN_ACCOUNT_RENT_PREFLIGHT_SIZE
      ).send());
    }
    if (input.needsReserveStateRent) {
      required += BigInt(await input.rpc.getMinimumBalanceForRentExemption(
        RESERVE_STATE_RENT_SIZE
      ).send());
    }
    if (balance < required) {
      throw new WorkspaceReserveInitializationError("reserve_gas_tank_insufficient_funds", 409);
    }
  } catch (error) {
    if (error instanceof WorkspaceReserveInitializationError) throw error;
    throw new WorkspaceReserveInitializationError("reserve_gas_tank_balance_unavailable", 503);
  }
}
function workspaceSeed(workspaceId: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(`paylore:workspace:v1:${workspaceId}`).digest());
}
async function deriveWorkspacePda(input: {
  authorityAddress: string; workspaceId: string; programId: string;
}) {
  const seed = workspaceSeed(input.workspaceId);
  const [workspace, bump] = await getProgramDerivedAddress({
    programAddress: address(input.programId),
    seeds: [
      encoder.encode("workspace"),
      getAddressEncoder().encode(address(input.authorityAddress)),
      seed
    ]
  });
  return { workspace, bump, seed };
}
async function resolveWorkspaceAuthority(
  db: Database, workspaceId: string, programId: string, fallbackAuthorityAddress: string
): Promise<string> {
  const prior = await getWorkspacePayrollProgramAuthority(db, { workspaceId, programId });
  return prior?.authorityAddress ?? fallbackAuthorityAddress;
}
function confidentialMintIsAvailable(mint: Mint): boolean {
  const extension = extensions(mint).find((item) => item.__kind === "ConfidentialTransferMint");
  return mint.decimals === 6 && Boolean(extension);
}
function assertConfidentialTokenReady(token: Token, reserveAddress: string, mint: string): void {
  const normalizedExtensions = extensions(token);
  const ready = hasApprovedConfidentialTransferAccount({
    owner: token.owner,
    mint: token.mint,
    extensions: normalizedExtensions.map((item) => ({
      __kind: item.__kind,
      approved: item.approved === true,
      allowConfidentialCredits: item.allowConfidentialCredits === true
    }))
  }, { owner: reserveAddress, mint });
  if (!ready) {
    throw new WorkspaceReserveInitializationError("reserve_confidential_account_not_ready", 409);
  }
}
async function inspectWorkspaceProgramState(
  rpc: ReturnType<typeof createSolanaRpc>,
  input: { workspace: string; bump: number; seed: Uint8Array; workspaceId: string; authorityAddress: string; programId: string }
): Promise<"workspace_program_not_initialized" | "workspace_verified"> {
  const result = await rpc.getAccountInfo(address(input.workspace), {
    commitment: "finalized", encoding: "base64"
  }).send();
  const account = object(result.value);
  if (!account) {
    return verifyWorkspaceProgramState({
      account: null, programId: input.programId, authorityAddress: input.authorityAddress,
      workspaceId: input.workspaceId, workspaceSeed: input.seed, expectedBump: input.bump
    }).status;
  }
  const data = account.data;
  if (!Array.isArray(data) || typeof account.owner !== "string") {
    throw new WorkspaceReserveInitializationError("workspace_program_state_invalid", 409);
  }
  const resultStatus = verifyWorkspaceProgramState({
    account: {
      owner: account.owner,
      executable: account.executable === true,
      data: [data[0] as string, data[1] as string]
    },
    programId: input.programId,
    authorityAddress: input.authorityAddress,
    workspaceId: input.workspaceId,
    workspaceSeed: input.seed,
    expectedBump: input.bump
  });
  return resultStatus.status;
}
async function inspectReserveProgramState(
  rpc: ReturnType<typeof createSolanaRpc>,
  input: {
    workspace: string; reserveAuthority: string; reserveToken: string; mint: string;
    programId: string; reserveState: string; reserveBump: number;
  }
): Promise<"reserve_program_not_configured" | "program_configured"> {
  const result = await rpc.getAccountInfo(address(input.reserveState), {
    commitment: "finalized", encoding: "base64"
  }).send();
  const account = object(result.value);
  if (!account) return "reserve_program_not_configured";
  const encoded = account.data;
  if (account.owner !== input.programId || account.executable === true ||
      !Array.isArray(encoded) || typeof encoded[0] !== "string" || encoded[1] !== "base64") {
    throw new WorkspaceReserveInitializationError("reserve_program_state_invalid", 409);
  }
  const base64 = encoded[0];
  const data = Buffer.from(base64, "base64");
  if (data.toString("base64") !== base64 || data.length !== 137 ||
      !data.subarray(0, 8).equals(Buffer.from(discriminator("account:WorkspaceReserveState")))) {
    throw new WorkspaceReserveInitializationError("reserve_program_state_malformed", 409);
  }
  const publicKey = (start: number) => Buffer.from(getAddressEncoder().encode(address([
    input.workspace, input.reserveAuthority, input.reserveToken, input.mint
  ][Math.floor(start / 32)]!)));
  if (
    !data.subarray(8, 40).equals(publicKey(0)) ||
    !data.subarray(40, 72).equals(publicKey(32)) ||
    !data.subarray(72, 104).equals(publicKey(64)) ||
    !data.subarray(104, 136).equals(publicKey(96)) ||
    data[136] !== input.reserveBump
  ) throw new WorkspaceReserveInitializationError("reserve_program_state_mismatch", 409);
  return "program_configured";
}
function configureWorkspaceReserveInstruction(input: {
  programId: string;
  authorityAddress: string;
  workspace: string;
  payerAddress: string;
  reserveState: string;
  reserveAuthority: string;
  reserveToken: string;
  mint: string;
}): Instruction {
  return {
    programAddress: address(input.programId),
    accounts: [
      { address: address(input.authorityAddress), role: AccountRole.READONLY },
      { address: address(input.workspace), role: AccountRole.READONLY },
      { address: address(input.payerAddress), role: AccountRole.WRITABLE_SIGNER },
      { address: address(input.reserveState), role: AccountRole.WRITABLE },
      { address: address(input.reserveAuthority), role: AccountRole.READONLY_SIGNER },
      { address: address(input.reserveToken), role: AccountRole.READONLY },
      { address: address(input.mint), role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY }
    ],
    data: discriminator("global:configure_workspace_reserve")
  };
}
async function deriveConfidentialBalanceSnapshot(
  rpc: ReturnType<typeof createSolanaRpc>,
  tokenAddress: string,
  elgamalSecretKey: ElGamalSecretKey,
  aesKey: AeKey
) {
  const balance = await fetchConfidentialTransferBalance({
    token: address(tokenAddress), rpc, elgamalSecretKey, aesKey
  });
  return {
    availableBalanceBaseUnits: balance.availableBalance.toString(),
    pendingBalanceBaseUnits: balance.pendingBalance.toString()
  };
}

async function withReserveContext<T>(
  db: Database,
  workspaceId: string,
  fallbackAuthorityAddress: string,
  run: (input: {
    signer: KeyPairSigner;
    feePayerSigner: KeyPairSigner | null;
    gasTankAddress: string | null;
    rpc: ReturnType<typeof createSolanaRpc>;
    reserveAddress: string;
    mintAddress: string;
    mintAccount: Mint;
    reserveTokenAddress: string;
    workspaceAuthority: string;
    workspace: string;
    workspaceSeed: Uint8Array;
    workspaceBump: number;
    reserveState: string;
    reserveBump: number;
    setupSignatures: {
      accountSetupSignature: string | null;
      programConfigureSignature: string | null;
    };
    elgamal: ElGamalKeypair;
    secret: ElGamalSecretKey;
    aesKey: AeKey;
    derived: Awaited<ReturnType<typeof deriveConfidentialKeys>>;
    programId: string;
  }) => Promise<T>,
  options: { requireGasTankFeePayer?: boolean } = {}
): Promise<T | WorkspaceConfidentialReserveResult> {
  const reserve = await getWorkspaceReserve(db, workspaceId);
  if (!reserve) return { status: "no_reserve" };
  const config = loadPayloreConfig();
  const mint = config.PAYLORE_WRAPPED_USDC_MINT;
  const programId = config.PAYLORE_PAYROLL_PROGRAM_ID;
  if (!mint || !programId) return { status: "not_configured", reserveAddress: reserve.address };
  return withWorkspaceReserveKey(db, workspaceId, async (privateBytes) => {
    const signer = await createKeyPairSignerFromBytes(privateBytes);
    if (signer.address !== reserve.address) {
      throw new WorkspaceReserveInitializationError("workspace_reserve_key_mismatch", 503);
    }
    const rpc = createSolanaRpc(rpcEndpoint());
    const mintAddress = address(mint);
    const mintAccount = (await fetchMint(rpc, mintAddress)).data;
    if (!confidentialMintIsAvailable(mintAccount)) {
      throw new WorkspaceReserveInitializationError("confidential_mint_unavailable", 503);
    }
    const [reserveTokenAddress] = await findAssociatedTokenPda({
      owner: address(signer.address), mint: mintAddress, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS
    });
    const workspaceAuthority = await resolveWorkspaceAuthority(
      db, workspaceId, programId, fallbackAuthorityAddress
    );
    const derivedWorkspace = await deriveWorkspacePda({
      authorityAddress: workspaceAuthority, workspaceId, programId
    });
    const [reserveState, reserveBump] = await getProgramDerivedAddress({
      programAddress: address(programId),
      seeds: [encoder.encode("reserve"), getAddressEncoder().encode(address(derivedWorkspace.workspace))]
    });
    const derived = await deriveConfidentialKeys({ signer });
    const secret = ElGamalSecretKey.fromBytes(derived.elgamalKeypair.secretKey);
    const elgamal = ElGamalKeypair.fromSecretKey(secret);
    const aesKey = AeKey.fromBytes(derived.aeKey);
    try {
      const context = {
        signer, rpc, reserveAddress: reserve.address, mintAddress, mintAccount, reserveTokenAddress,
        workspaceAuthority, workspace: derivedWorkspace.workspace, workspaceSeed: derivedWorkspace.seed,
        workspaceBump: derivedWorkspace.bump, reserveState, reserveBump,
        setupSignatures: {
          accountSetupSignature: reserve.confidentialAccountSetupSignature,
          programConfigureSignature: reserve.programReserveSetupSignature
        },
        elgamal, secret, aesKey, derived, programId
      };
      if (!options.requireGasTankFeePayer) {
        return await run({ ...context, feePayerSigner: null, gasTankAddress: null });
      }
      const gasTank = await getWorkspaceGasTank(db, workspaceId);
      if (!gasTank) {
        throw new WorkspaceReserveInitializationError("reserve_gas_tank_not_initialized", 409);
      }
      try {
        return await withWorkspaceGasTankKey(db, workspaceId, async (gasTankPrivateBytes) => {
          const feePayerSigner = await createKeyPairSignerFromBytes(gasTankPrivateBytes);
          if (feePayerSigner.address !== gasTank.address) {
            throw new WorkspaceReserveInitializationError("reserve_gas_tank_key_mismatch", 503);
          }
          return await run({ ...context, feePayerSigner, gasTankAddress: gasTank.address });
        });
      } catch (error) {
        if (error instanceof WorkspaceReserveInitializationError) throw error;
        throw new WorkspaceReserveInitializationError("reserve_gas_tank_custody_unavailable", 503);
      }
    } finally {
      secret.free(); elgamal.free(); aesKey.free();
      derived.elgamalKeypair.secretKey.fill(0); derived.aeKey.fill(0);
    }
  });
}

export async function getWorkspaceConfidentialReserveSnapshot(
  db: Database,
  workspaceId: string,
  fallbackAuthorityAddress: string
): Promise<WorkspaceConfidentialReserveResult> {
  const context = await withReserveContext(db, workspaceId, fallbackAuthorityAddress, async (input) => {
    const {
      status, tokenAccount, confidentialTransferReady, publicBalanceBaseUnits,
      availableBalanceBaseUnits, pendingBalanceBaseUnits, fundingState
    } = await inspectTokenAccount(input);
    if (status === "account_missing") {
      return { status: "account_missing", reserveAddress: input.reserveAddress, tokenAccount };
    }
    const workspaceStatus = await inspectWorkspaceProgramState(input.rpc, {
      workspace: input.workspace, bump: input.workspaceBump, seed: input.workspaceSeed,
      workspaceId, authorityAddress: input.workspaceAuthority, programId: input.programId
    });
    if (workspaceStatus === "workspace_program_not_initialized") {
      return {
        status: "workspace_program_not_initialized", reserveAddress: input.reserveAddress,
        tokenAccount, confidentialTransferReady, publicBalanceBaseUnits, availableBalanceBaseUnits, pendingBalanceBaseUnits,
        fundingState, programReserveConfigured: false
      };
    }
    const reserveStatus = await inspectReserveProgramState(input.rpc, {
      workspace: input.workspace, reserveAuthority: input.reserveAddress, reserveToken: tokenAccount!,
      mint: input.mintAddress, programId: input.programId, reserveState: input.reserveState, reserveBump: input.reserveBump
    });
    return {
      status: reserveStatus === "program_configured" ? "program_configured" : "confidential_account_ready",
      reserveAddress: input.reserveAddress, tokenAccount,
      confidentialTransferReady, publicBalanceBaseUnits, availableBalanceBaseUnits, pendingBalanceBaseUnits,
      fundingState, programReserveConfigured: reserveStatus === "program_configured"
    };
  });
  return context as WorkspaceConfidentialReserveResult;
}


type SerializedReserveInstruction = {
  programAddress: string;
  dataBase64: string;
  accountAddresses: string[];
};

type ReserveFundingTokenBalance = {
  accountIndex?: unknown;
  mint?: unknown;
  owner?: unknown;
  programId?: unknown;
  uiTokenAmount?: { amount?: unknown; decimals?: unknown } | null;
};

type ReserveFundingTransaction = {
  slot?: unknown;
  meta?: {
    err?: unknown;
    fee?: unknown;
    preTokenBalances?: ReserveFundingTokenBalance[] | null;
    postTokenBalances?: ReserveFundingTokenBalance[] | null;
    loadedAddresses?: { writable?: unknown[]; readonly?: unknown[] } | null;
  } | null;
  transaction?: {
    signatures?: unknown;
    message?: {
      header?: { numRequiredSignatures?: unknown } | null;
      accountKeys?: unknown;
      instructions?: unknown;
    } | null;
  } | null;
} | null;

function serializeReserveInstruction(instruction: Instruction): SerializedReserveInstruction {
  return {
    programAddress: instruction.programAddress,
    dataBase64: Buffer.from(instruction.data).toString("base64"),
    accountAddresses: (instruction.accounts ?? []).map((account) => account.address)
  };
}

function reserveFundingTransactionKeys(
  message: Record<string, unknown>,
  meta: NonNullable<ReserveFundingTransaction>["meta"]
): string[] {
  const values = Array.isArray(message.accountKeys) ? message.accountKeys : [];
  const keys = values.map((entry) => {
    if (typeof entry === "string") return entry;
    const row = object(entry);
    return typeof row?.pubkey === "string" ? row.pubkey : "";
  });
  const loaded = object(meta?.loadedAddresses);
  const extra = [
    ...(Array.isArray(loaded?.writable) ? loaded!.writable as unknown[] : []),
    ...(Array.isArray(loaded?.readonly) ? loaded!.readonly as unknown[] : [])
  ].map((entry) => {
    if (typeof entry === "string") return entry;
    const row = object(entry);
    return typeof row?.pubkey === "string" ? row.pubkey : "";
  });
  return [...keys, ...extra];
}

function decodeReserveBase58(value: string): Uint8Array | null {
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

function reserveInstructionProgram(instruction: Record<string, unknown>, keys: string[]): string {
  if (typeof instruction.programId === "string") return instruction.programId;
  return typeof instruction.programIdIndex === "number"
    ? keys[instruction.programIdIndex] ?? ""
    : "";
}

function reserveInstructionAccounts(instruction: Record<string, unknown>, keys: string[]): string[] {
  if (!Array.isArray(instruction.accounts)) return [];
  return instruction.accounts.map((entry) =>
    typeof entry === "string" ? entry :
      typeof entry === "number" ? keys[entry] ?? "" : ""
  );
}

function reserveInstructionData(instruction: Record<string, unknown>): Uint8Array | null {
  return typeof instruction.data === "string" ? decodeReserveBase58(instruction.data) : null;
}

function hasReserveMemo(
  message: Record<string, unknown>,
  keys: string[],
  marker: string
): boolean {
  const instructions = Array.isArray(message.instructions) ? message.instructions : [];
  return instructions.some((value) => {
    const instruction = object(value);
    if (!instruction || reserveInstructionProgram(instruction, keys) !== "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr") {
      return false;
    }
    const data = reserveInstructionData(instruction);
    return data !== null && new TextDecoder().decode(data) === marker;
  });
}

function verifyReserveInstructionInTransaction(
  transaction: NonNullable<ReserveFundingTransaction>,
  expected: SerializedReserveInstruction,
  marker: string,
  reserveAddress: string
): void {
  const meta = object(transaction.meta);
  const body = object(transaction.transaction);
  const message = object(body?.message);
  const signatures = body?.signatures;
  if (!meta || !message || !Array.isArray(signatures) ||
      meta.err !== null || !signatures.length || typeof transaction.slot !== "number") {
    throw new WorkspaceReserveInitializationError("reserve_confidential_funding_transaction_not_finalized", 202);
  }
  const keys = reserveFundingTransactionKeys(message, meta as NonNullable<ReserveFundingTransaction>["meta"]);
  const header = object(message.header);
  const required = header?.numRequiredSignatures;
  const signer = Array.isArray(message.accountKeys) && message.accountKeys.some((value, index) => {
    const row = object(value);
    const isSigner = typeof row?.signer === "boolean"
      ? row.signer
      : typeof required === "number" && index < required;
    const key = typeof value === "string" ? value : object(value)?.pubkey;
    return key === reserveAddress && isSigner;
  });
  if (!signer) {
    throw new WorkspaceReserveInitializationError("reserve_confidential_funding_authority_mismatch", 409);
  }
  const instructions = Array.isArray(message.instructions) ? message.instructions : [];
  const matches = instructions.filter((value) => {
    const instruction = object(value);
    if (!instruction || reserveInstructionProgram(instruction, keys) !== expected.programAddress) return false;
    const actualData = reserveInstructionData(instruction);
    const expectedData = Buffer.from(expected.dataBase64, "base64");
    return actualData !== null &&
      Buffer.from(actualData).equals(expectedData) &&
      JSON.stringify(reserveInstructionAccounts(instruction, keys)) === JSON.stringify(expected.accountAddresses);
  });
  if (matches.length !== 1 || !hasReserveMemo(message, keys, marker)) {
    throw new WorkspaceReserveInitializationError("reserve_confidential_funding_instruction_mismatch", 409);
  }
}

function reserveTokenBalanceAmount(
  rows: ReserveFundingTokenBalance[] | null | undefined,
  index: number,
  mint: string,
  owner: string
): bigint {
  const matches = (rows ?? []).filter((row) => row.accountIndex === index);
  if (matches.length !== 1) {
    throw new WorkspaceReserveInitializationError("reserve_confidential_funding_balance_unavailable", 409);
  }
  const row = matches[0];
  const amount = row.uiTokenAmount?.amount;
  if (
    row.mint !== mint || row.owner !== owner ||
    (row.programId !== undefined && row.programId !== TOKEN_2022_PROGRAM_ADDRESS) ||
    typeof amount !== "string" || !/^(0|[1-9][0-9]*)$/.test(amount) ||
    row.uiTokenAmount?.decimals !== 6
  ) {
    throw new WorkspaceReserveInitializationError("reserve_confidential_funding_account_mismatch", 409);
  }
  return BigInt(amount);
}

function assertReservePublicBalanceDelta(input: {
  transaction: NonNullable<ReserveFundingTransaction>;
  tokenAddress: string;
  mintAddress: string;
  reserveAddress: string;
  deltaBaseUnits: bigint;
}): void {
  const meta = object(input.transaction.meta) as NonNullable<ReserveFundingTransaction>["meta"];
  const body = object(input.transaction.transaction);
  const message = object(body?.message);
  if (!meta || !message) {
    throw new WorkspaceReserveInitializationError("reserve_confidential_funding_transaction_not_finalized", 202);
  }
  const keys = reserveFundingTransactionKeys(message, meta);
  const index = keys.indexOf(input.tokenAddress);
  if (index < 0) {
    throw new WorkspaceReserveInitializationError("reserve_confidential_funding_account_mismatch", 409);
  }
  const before = reserveTokenBalanceAmount(meta.preTokenBalances, index, input.mintAddress, input.reserveAddress);
  const after = reserveTokenBalanceAmount(meta.postTokenBalances, index, input.mintAddress, input.reserveAddress);
  if (before - after !== input.deltaBaseUnits) {
    throw new WorkspaceReserveInitializationError("reserve_confidential_funding_public_debit_mismatch", 409);
  }
}

async function readReserveFundingTransaction(
  signatureText: string
): Promise<NonNullable<ReserveFundingTransaction>> {
  let transaction: ReserveFundingTransaction;
  try {
    transaction = await readSolanaRpc<ReserveFundingTransaction>("getTransaction", [
      signatureText,
      { commitment: "finalized", encoding: "json", maxSupportedTransactionVersion: 0 }
    ]);
  } catch {
    throw new WorkspaceReserveInitializationError("reserve_confidential_funding_status_unavailable", 503);
  }
  if (!transaction || !transaction.meta || !transaction.transaction ||
      typeof transaction.slot !== "number" || transaction.meta.err === undefined) {
    throw new WorkspaceReserveInitializationError("reserve_confidential_funding_transaction_not_finalized", 202);
  }
  if (transaction.meta.err !== null) {
    throw new WorkspaceReserveInitializationError("reserve_confidential_funding_transaction_failed", 409);
  }
  return transaction;
}

async function readReserveFundingFee(transaction: NonNullable<ReserveFundingTransaction>): Promise<string> {
  const fee = transaction.meta?.fee;
  if (typeof fee !== "number" || !Number.isSafeInteger(fee) || fee < 0) {
    throw new WorkspaceReserveInitializationError("reserve_confidential_funding_fee_unavailable", 503);
  }
  return String(fee);
}

async function findReserveFundingSignatureByMemo(
  tokenAddress: string,
  marker: string
): Promise<string | null> {
  let rows: Array<{ signature?: string }> = [];
  try {
    rows = await readSolanaRpc<Array<{ signature?: string }>>("getSignaturesForAddress", [
      tokenAddress,
      { commitment: "confirmed", limit: 40 }
    ]);
  } catch {
    throw new WorkspaceReserveInitializationError("reserve_confidential_funding_status_unavailable", 503);
  }
  for (const row of rows) {
    if (typeof row.signature !== "string") continue;
    let transaction: ReserveFundingTransaction;
    try {
      transaction = await readSolanaRpc<ReserveFundingTransaction>("getTransaction", [
        row.signature,
        { commitment: "confirmed", encoding: "json", maxSupportedTransactionVersion: 0 }
      ]);
    } catch {
      continue;
    }
    const body = object(transaction?.transaction);
    const message = object(body?.message);
    if (!message) continue;
    const meta = object(transaction?.meta);
    const keys = reserveFundingTransactionKeys(message, meta as NonNullable<ReserveFundingTransaction>["meta"] ?? null);
    if (hasReserveMemo(message, keys, marker)) return row.signature;
  }
  return null;
}

type WorkspaceReserveConfidentialFundingResult = {
  status: "confidential_balance_verified" | "pending";
  wrapSignature: string;
  depositSignature?: string;
  applySignature?: string;
  amountBaseUnits: string;
  publicBalanceBaseUnits?: string;
  availableBalanceBaseUnits?: string;
};

const MAX_CONFIDENTIAL_DEPOSIT_BASE_UNITS = (1n << 48n) - 1n;

function reserveFundingMemo(wrapSignature: string, phase: "preapply" | "deposit" | "apply"): string {
  return "PAYLORE_RESERVE_FUNDING:v1:" + wrapSignature + ":" + phase;
}

/** Converts the verified public Reserve credit into pending and then spendable confidential funds. */
export async function completeWorkspaceReserveConfidentialFunding(input: {
  db: Database;
  workspaceId: string;
  fallbackAuthorityAddress: string;
  amountBaseUnits: string;
  wrapSignature: string;
}): Promise<WorkspaceReserveConfidentialFundingResult> {
  if (
    !/^[1-9][0-9]{0,19}$/.test(input.amountBaseUnits) ||
    BigInt(input.amountBaseUnits) > MAX_CONFIDENTIAL_DEPOSIT_BASE_UNITS ||
    !/^[1-9A-HJ-NP-Za-km-z]{80,90}$/.test(input.wrapSignature)
  ) {
    throw new WorkspaceReserveInitializationError("reserve_confidential_deposit_amount_invalid", 400);
  }
  const amount = BigInt(input.amountBaseUnits);
  const result = await withReserveContext(
    input.db,
    input.workspaceId,
    input.fallbackAuthorityAddress,
    async (context) => {
      if (!context.feePayerSigner || !context.gasTankAddress) {
        throw new WorkspaceReserveInitializationError("reserve_gas_tank_not_initialized", 409);
      }
      const account = await inspectTokenAccount({
        rpc: context.rpc,
        reserveAddress: context.reserveAddress,
        reserveTokenAddress: context.reserveTokenAddress,
        mintAddress: context.mintAddress,
        secret: context.secret,
        aesKey: context.aesKey
      });
      if (
        account.status !== "account_ready" ||
        !account.confidentialTransferReady ||
        account.tokenAccount !== context.reserveTokenAddress ||
        !account.publicBalanceBaseUnits ||
        !account.availableBalanceBaseUnits ||
        !account.pendingBalanceBaseUnits
      ) {
        throw new WorkspaceReserveInitializationError("reserve_confidential_account_not_ready", 409);
      }
      const workspaceStatus = await inspectWorkspaceProgramState(context.rpc, {
        workspace: context.workspace,
        bump: context.workspaceBump,
        seed: context.workspaceSeed,
        workspaceId: input.workspaceId,
        authorityAddress: context.workspaceAuthority,
        programId: context.programId
      });
      if (workspaceStatus === "workspace_program_not_initialized") {
        throw new WorkspaceReserveInitializationError("workspace_program_not_initialized", 409);
      }
      const reserveStatus = await inspectReserveProgramState(context.rpc, {
        workspace: context.workspace,
        reserveAuthority: context.reserveAddress,
        reserveToken: context.reserveTokenAddress,
        mint: context.mintAddress,
        programId: context.programId,
        reserveState: context.reserveState,
        reserveBump: context.reserveBump
      });
      if (reserveStatus !== "program_configured") {
        throw new WorkspaceReserveInitializationError("reserve_program_not_configured", 409);
      }

      const publicBefore = BigInt(account.publicBalanceBaseUnits);
      const availableBefore = BigInt(account.availableBalanceBaseUnits);
      const pendingBefore = BigInt(account.pendingBalanceBaseUnits);
      if (publicBefore < amount) {
        throw new WorkspaceReserveInitializationError("reserve_confidential_funding_public_balance_insufficient", 409);
      }
      const idempotencyKey = "reserve_funding:" + input.wrapSignature;
      const requestDigest = createHash("sha256").update([
        input.workspaceId, input.fallbackAuthorityAddress, input.amountBaseUnits,
        input.wrapSignature, context.reserveAddress, context.reserveTokenAddress, context.mintAddress
      ].join("|")).digest("hex");
      const begun = await beginWorkspaceReserveFundingOperation(input.db, {
        workspaceId: input.workspaceId,
        idempotencyKey,
        requestDigest,
        wrapSignature: input.wrapSignature,
        operationData: {
          walletAddress: input.fallbackAuthorityAddress,
          amountBaseUnits: input.amountBaseUnits,
          wrapSignature: input.wrapSignature,
          reserveAddress: context.reserveAddress,
          reserveTokenAddress: context.reserveTokenAddress,
          mintAddress: context.mintAddress,
          initialPublicBalanceBaseUnits: account.publicBalanceBaseUnits,
          initialAvailableBalanceBaseUnits: account.availableBalanceBaseUnits,
          initialPendingBalanceBaseUnits: account.pendingBalanceBaseUnits
        }
      });
      if (begun.status === "reserve_not_found") {
        throw new WorkspaceReserveInitializationError("reserve_not_found", 409);
      }
      if (begun.status === "in_progress" || begun.status === "conflict" || begun.status === "invalid" || !begun.operation) {
        throw new WorkspaceReserveInitializationError("reserve_confidential_funding_in_progress", 409);
      }
      let operationData = object(begun.operation.operationData) ?? {};
      if (
        operationData.walletAddress !== input.fallbackAuthorityAddress ||
        operationData.amountBaseUnits !== input.amountBaseUnits ||
        operationData.wrapSignature !== input.wrapSignature ||
        operationData.reserveAddress !== context.reserveAddress ||
        operationData.reserveTokenAddress !== context.reserveTokenAddress ||
        operationData.mintAddress !== context.mintAddress
      ) {
        throw new WorkspaceReserveInitializationError("reserve_confidential_funding_operation_conflict", 409);
      }
      let stage = String(operationData.stage ?? "");
      const save = async (
        expectedStage: ReserveFundingOperationStage,
        nextStage: ReserveFundingOperationStage,
        patch: Record<string, unknown> = {},
        feeLamportsAdded = "0"
      ) => {
        const saved = await advanceWorkspaceReserveFundingOperation(input.db, {
          workspaceId: input.workspaceId,
          operationId: begun.operation!.id,
          expectedStage,
          nextStage,
          operationData: patch,
          feeLamportsAdded
        });
        if (saved !== "updated" && saved !== "duplicate") {
          throw new WorkspaceReserveInitializationError("reserve_confidential_funding_operation_conflict", 409);
        }
        operationData = { ...operationData, ...patch, stage: nextStage };
        stage = nextStage;
      };
      const pending = (): WorkspaceReserveConfidentialFundingResult => ({
        status: "pending",
        wrapSignature: input.wrapSignature,
        depositSignature: typeof operationData.depositSignature === "string" ? operationData.depositSignature : undefined,
        applySignature: typeof operationData.applySignature === "string" ? operationData.applySignature : undefined,
        amountBaseUnits: input.amountBaseUnits
      });
      if (begun.status === "finalized" || stage === "finalized") {
        return {
          status: "confidential_balance_verified",
          wrapSignature: input.wrapSignature,
          depositSignature: String(operationData.depositSignature ?? ""),
          applySignature: String(operationData.applySignature ?? ""),
          amountBaseUnits: input.amountBaseUnits,
          publicBalanceBaseUnits: String(operationData.finalPublicBalanceBaseUnits ?? ""),
          availableBalanceBaseUnits: String(operationData.finalAvailableBalanceBaseUnits ?? "")
        };
      }
      if (stage === "wrap_verified" && pendingBefore > 0n) {
        const token = (await fetchToken(context.rpc, address(context.reserveTokenAddress))).data;
        const instruction = getApplyConfidentialPendingBalanceInstructionFromToken({
          token: address(context.reserveTokenAddress),
          tokenAccount: token,
          authority: context.signer,
          elgamalSecretKey: context.secret,
          aesKey: context.aesKey
        });
        const expected = serializeReserveInstruction(instruction);
        await save("wrap_verified", "preapply_submitting", {
          preapplyInstruction: expected,
          preapplyMarker: reserveFundingMemo(input.wrapSignature, "preapply"),
          preapplyStartedAt: new Date().toISOString()
        });
      } else if (stage === "wrap_verified") {
        await save("wrap_verified", "preapply_finalized", {
          availableBeforeDepositBaseUnits: account.availableBalanceBaseUnits,
          publicBeforeDepositBaseUnits: account.publicBalanceBaseUnits
        });
      }

      if (stage === "preapply_submitting") {
        const marker = String(operationData.preapplyMarker ?? reserveFundingMemo(input.wrapSignature, "preapply"));
        let txSignature = typeof operationData.preapplySignature === "string" ? operationData.preapplySignature : null;
        if (!txSignature) {
          txSignature = await findReserveFundingSignatureByMemo(context.reserveTokenAddress, marker);
          if (!txSignature) return pending();
          await save("preapply_submitting", "preapply_submitted", { preapplySignature: txSignature });
        }
        stage = "preapply_submitted";
      }
      if (stage === "preapply_submitted") {
        const txSignature = String(operationData.preapplySignature);
        const finality = await waitForFinality(context.rpc, signature(getBase58Decoder().decode(txSignature)));
        if (finality === "pending") return pending();
        const transaction = await readReserveFundingTransaction(txSignature);
        const expected = object(operationData.preapplyInstruction) as unknown as SerializedReserveInstruction;
        verifyReserveInstructionInTransaction(
          transaction, expected, String(operationData.preapplyMarker), context.reserveAddress
        );
        assertReservePublicBalanceDelta({
          transaction, tokenAddress: context.reserveTokenAddress, mintAddress: context.mintAddress,
          reserveAddress: context.reserveAddress, deltaBaseUnits: 0n
        });
        const balances = await deriveConfidentialBalanceSnapshot(
          context.rpc, context.reserveTokenAddress, context.secret, context.aesKey
        );
        if (
          finality !== "finalized" ||
          BigInt(balances.pendingBalanceBaseUnits) !== 0n ||
          BigInt(balances.availableBalanceBaseUnits) !== availableBefore + pendingBefore
        ) {
          throw new WorkspaceReserveInitializationError("reserve_confidential_preapply_balance_mismatch", 409);
        }
        await save("preapply_submitted", "preapply_finalized", {
          availableBeforeDepositBaseUnits: balances.availableBalanceBaseUnits,
          publicBeforeDepositBaseUnits: account.publicBalanceBaseUnits,
          preapplyFinalizedAt: new Date().toISOString()
        }, await readReserveFundingFee(transaction));
      }
      if (stage === "preapply_failed") {
        await save("preapply_failed", "preapply_submitting", {
          preapplyInstruction: undefined,
          preapplySignature: undefined,
          preapplyMarker: reserveFundingMemo(input.wrapSignature, "preapply"),
          preapplyStartedAt: new Date().toISOString()
        });
      }

      if (stage === "preapply_finalized" || stage === "deposit_failed") {
        const token = (await fetchToken(context.rpc, address(context.reserveTokenAddress))).data;
        const balance = await fetchConfidentialTransferBalance({
          token: address(context.reserveTokenAddress),
          rpc: context.rpc,
          elgamalSecretKey: context.secret,
          aesKey: context.aesKey
        });
        if (balance.pendingBalance !== 0n) {
          throw new WorkspaceReserveInitializationError("reserve_confidential_pending_balance_not_cleared", 409);
        }
        const publicNow = BigInt(token.amount);
        const availableNow = balance.availableBalance;
        const expectedPublicBefore = BigInt(String(operationData.publicBeforeDepositBaseUnits ?? publicBefore.toString()));
        const expectedAvailableBefore = BigInt(String(operationData.availableBeforeDepositBaseUnits ?? availableBefore.toString()));
        if (publicNow !== expectedPublicBefore || availableNow !== expectedAvailableBefore) {
          throw new WorkspaceReserveInitializationError("reserve_confidential_funding_balance_changed", 409);
        }
        const instruction = getConfidentialDepositInstruction({
          token: address(context.reserveTokenAddress),
          mint: address(context.mintAddress),
          authority: context.signer,
          amount,
          decimals: 6
        });
        const expected = serializeReserveInstruction(instruction);
        const marker = reserveFundingMemo(input.wrapSignature, "deposit");
        const expectedStage = stage as "preapply_finalized" | "deposit_failed";
        await save(expectedStage, "deposit_submitting", {
          depositInstruction: expected,
          depositMarker: marker,
          depositStartedAt: new Date().toISOString()
        });
      }
      if (stage === "deposit_submitting") {
        const marker = String(operationData.depositMarker ?? reserveFundingMemo(input.wrapSignature, "deposit"));
        let txSignature = typeof operationData.depositSignature === "string" ? operationData.depositSignature : null;
        if (!txSignature) {
          txSignature = await findReserveFundingSignatureByMemo(context.reserveTokenAddress, marker);
          if (!txSignature) return pending();
          await save("deposit_submitting", "deposit_submitted", { depositSignature: txSignature });
        }
        stage = "deposit_submitted";
      }
      if (stage === "deposit_submitted") {
        const txSignature = String(operationData.depositSignature);
        const finality = await waitForFinality(context.rpc, signature(getBase58Decoder().decode(txSignature)));
        if (finality === "pending") return pending();
        const transaction = await readReserveFundingTransaction(txSignature);
        const expected = object(operationData.depositInstruction) as unknown as SerializedReserveInstruction;
        verifyReserveInstructionInTransaction(
          transaction, expected, String(operationData.depositMarker), context.reserveAddress
        );
        assertReservePublicBalanceDelta({
          transaction, tokenAddress: context.reserveTokenAddress, mintAddress: context.mintAddress,
          reserveAddress: context.reserveAddress, deltaBaseUnits: amount
        });
        const token = (await fetchToken(context.rpc, address(context.reserveTokenAddress))).data;
        const balance = await fetchConfidentialTransferBalance({
          token: address(context.reserveTokenAddress),
          rpc: context.rpc,
          elgamalSecretKey: context.secret,
          aesKey: context.aesKey
        });
        const publicBeforeDeposit = BigInt(String(operationData.publicBeforeDepositBaseUnits));
        const availableBeforeDeposit = BigInt(String(operationData.availableBeforeDepositBaseUnits));
        if (
          finality !== "finalized" ||
          BigInt(token.amount) !== publicBeforeDeposit - amount ||
          balance.pendingBalance !== amount ||
          balance.availableBalance !== availableBeforeDeposit
        ) {
          throw new WorkspaceReserveInitializationError("reserve_confidential_deposit_balance_mismatch", 409);
        }
        await save("deposit_submitted", "deposit_finalized", {
          depositPublicBalanceAfterBaseUnits: token.amount.toString(),
          depositPendingBalanceAfterBaseUnits: balance.pendingBalance.toString(),
          depositFinalizedAt: new Date().toISOString()
        }, await readReserveFundingFee(transaction));
      }
      if (stage === "deposit_failed") {
        await save("deposit_failed", "deposit_submitting", {
          depositInstruction: undefined,
          depositSignature: undefined,
          depositMarker: reserveFundingMemo(input.wrapSignature, "deposit"),
          depositStartedAt: new Date().toISOString()
        });
      }

      if (stage === "deposit_finalized" || stage === "apply_failed") {
        const token = (await fetchToken(context.rpc, address(context.reserveTokenAddress))).data;
        const balance = await fetchConfidentialTransferBalance({
          token: address(context.reserveTokenAddress),
          rpc: context.rpc,
          elgamalSecretKey: context.secret,
          aesKey: context.aesKey
        });
        if (balance.pendingBalance !== amount) {
          throw new WorkspaceReserveInitializationError("reserve_confidential_pending_balance_mismatch", 409);
        }
        const instruction = getApplyConfidentialPendingBalanceInstructionFromToken({
          token: address(context.reserveTokenAddress),
          tokenAccount: token,
          authority: context.signer,
          elgamalSecretKey: context.secret,
          aesKey: context.aesKey
        });
        const expected = serializeReserveInstruction(instruction);
        const marker = reserveFundingMemo(input.wrapSignature, "apply");
        const expectedStage = stage as "deposit_finalized" | "apply_failed";
        await save(expectedStage, "apply_submitting", {
          applyInstruction: expected,
          applyMarker: marker,
          applyStartedAt: new Date().toISOString()
        });
      }
      if (stage === "apply_submitting") {
        const marker = String(operationData.applyMarker ?? reserveFundingMemo(input.wrapSignature, "apply"));
        let txSignature = typeof operationData.applySignature === "string" ? operationData.applySignature : null;
        if (!txSignature) {
          txSignature = await findReserveFundingSignatureByMemo(context.reserveTokenAddress, marker);
          if (!txSignature) return pending();
          await save("apply_submitting", "apply_submitted", { applySignature: txSignature });
        }
        stage = "apply_submitted";
      }
      if (stage === "apply_submitted") {
        const txSignature = String(operationData.applySignature);
        const finality = await waitForFinality(context.rpc, signature(getBase58Decoder().decode(txSignature)));
        if (finality === "pending") return pending();
        const transaction = await readReserveFundingTransaction(txSignature);
        const expected = object(operationData.applyInstruction) as unknown as SerializedReserveInstruction;
        verifyReserveInstructionInTransaction(
          transaction, expected, String(operationData.applyMarker), context.reserveAddress
        );
        assertReservePublicBalanceDelta({
          transaction, tokenAddress: context.reserveTokenAddress, mintAddress: context.mintAddress,
          reserveAddress: context.reserveAddress, deltaBaseUnits: 0n
        });
        const token = (await fetchToken(context.rpc, address(context.reserveTokenAddress))).data;
        const balance = await fetchConfidentialTransferBalance({
          token: address(context.reserveTokenAddress),
          rpc: context.rpc,
          elgamalSecretKey: context.secret,
          aesKey: context.aesKey
        });
        const availableBeforeDeposit = BigInt(String(operationData.availableBeforeDepositBaseUnits));
        const publicAfterDeposit = BigInt(String(operationData.depositPublicBalanceAfterBaseUnits));
        if (
          finality !== "finalized" ||
          BigInt(token.amount) !== publicAfterDeposit ||
          balance.pendingBalance !== 0n ||
          balance.availableBalance !== availableBeforeDeposit + amount
        ) {
          throw new WorkspaceReserveInitializationError("reserve_confidential_apply_balance_mismatch", 409);
        }
        await save("apply_submitted", "finalized", {
          finalPublicBalanceBaseUnits: token.amount.toString(),
          finalAvailableBalanceBaseUnits: balance.availableBalance.toString(),
          confidentialFundingVerifiedAt: new Date().toISOString()
        }, await readReserveFundingFee(transaction));
      }
      if (stage !== "finalized") return pending();
      return {
        status: "confidential_balance_verified",
        wrapSignature: input.wrapSignature,
        depositSignature: String(operationData.depositSignature),
        applySignature: String(operationData.applySignature),
        amountBaseUnits: input.amountBaseUnits,
        publicBalanceBaseUnits: String(operationData.finalPublicBalanceBaseUnits),
        availableBalanceBaseUnits: String(operationData.finalAvailableBalanceBaseUnits)
      };
    },
    { requireGasTankFeePayer: true }
  );
  if (!result || typeof result !== "object" || !("status" in result)) {
    throw new WorkspaceReserveInitializationError("reserve_confidential_funding_unavailable", 503);
  }
  return result as WorkspaceReserveConfidentialFundingResult;
}

async function inspectTokenAccount(input: {
  rpc: ReturnType<typeof createSolanaRpc>;
  reserveAddress: string;
  reserveTokenAddress: string;
  mintAddress: string;
  secret: ElGamalSecretKey;
  aesKey: AeKey;
}): Promise<{
  status: "account_missing" | "account_ready";
  tokenAccount: string;
  confidentialTransferReady: boolean;
  publicBalanceBaseUnits?: string;
  availableBalanceBaseUnits?: string;
  pendingBalanceBaseUnits?: string;
  fundingState?: ReserveFundingState;
}> {
  const encoded = await fetchEncodedAccount(input.rpc, address(input.reserveTokenAddress));
  if (!encoded.exists) {
    return { status: "account_missing", tokenAccount: input.reserveTokenAddress, confidentialTransferReady: false };
  }
  if (encoded.programAddress !== TOKEN_2022_PROGRAM_ADDRESS) {
    throw new WorkspaceReserveInitializationError("reserve_token_account_program_mismatch", 409);
  }
  const token = (await fetchToken(input.rpc, address(input.reserveTokenAddress))).data;
  const ready = hasApprovedConfidentialTransferAccount({
    owner: token.owner,
    mint: token.mint,
    extensions: extensions(token).map((item) => ({
      __kind: item.__kind,
      approved: item.approved === true,
      allowConfidentialCredits: item.allowConfidentialCredits === true
    }))
  }, { owner: input.reserveAddress, mint: input.mintAddress });
  if (!ready) throw new WorkspaceReserveInitializationError("reserve_confidential_account_not_ready", 409);
  const publicBalanceBaseUnits = token.amount.toString();
  const confidentialBalances = await deriveConfidentialBalanceSnapshot(
    input.rpc, input.reserveTokenAddress, input.secret, input.aesKey
  );
  const fundingState = classifyReserveFundingState({
    publicBalanceBaseUnits,
    ...confidentialBalances
  });
  return {
    status: "account_ready",
    tokenAccount: input.reserveTokenAddress,
    confidentialTransferReady: true,
    publicBalanceBaseUnits,
    ...confidentialBalances,
    fundingState
  };
}

/** Creates the reserve-owned confidential token account and binds the program reserve only to a verified WorkspaceState. */
export async function initializeWorkspaceConfidentialReserveAccount(
  db: Database,
  workspaceId: string,
  fallbackAuthorityAddress: string,
  continuation: { signature?: string | null; phase?: WorkspaceReservePhase | null } = {}
): Promise<WorkspaceConfidentialReserveResult> {
  const result = await withReserveContext(db, workspaceId, fallbackAuthorityAddress, async (input) => {
    const feePayerSigner = input.feePayerSigner;
    const gasTankAddress = input.gasTankAddress;
    if (!feePayerSigner || !gasTankAddress) {
      throw new WorkspaceReserveInitializationError("reserve_gas_tank_not_initialized", 409);
    }
    const pendingAttempt = continuation.signature && continuation.phase
      ? { signature: continuation.signature, phase: continuation.phase }
      : input.setupSignatures.programConfigureSignature
        ? { signature: input.setupSignatures.programConfigureSignature, phase: "program_configure" as const }
        : input.setupSignatures.accountSetupSignature
          ? { signature: input.setupSignatures.accountSetupSignature, phase: "account_setup" as const }
          : null;
    if (pendingAttempt) {
      const previous = await waitForFinality(input.rpc, pendingAttempt.signature as Signature);
      if (previous === "pending") {
        return {
          status: "pending",
          reserveAddress: input.reserveAddress,
          signature: pendingAttempt.signature,
          phase: pendingAttempt.phase
        };
      }
      if (previous === "failed") {
        await clearWorkspaceReserveSetupSignature(db, {
          workspaceId, phase: pendingAttempt.phase, signature: pendingAttempt.signature
        });
        return {
          status: "retry_ready",
          reserveAddress: input.reserveAddress,
          signature: pendingAttempt.signature,
          phase: pendingAttempt.phase
        };
      }
      await clearWorkspaceReserveSetupSignature(db, {
        workspaceId, phase: pendingAttempt.phase, signature: pendingAttempt.signature
      });
    }

    const encoded = await fetchEncodedAccount(input.rpc, address(input.reserveTokenAddress));
    let accountReady = false;
    if (encoded.exists && encoded.programAddress !== TOKEN_2022_PROGRAM_ADDRESS) {
      throw new WorkspaceReserveInitializationError("reserve_token_account_program_mismatch", 409);
    }
    if (encoded.exists) {
      const existing = (await fetchToken(input.rpc, address(input.reserveTokenAddress))).data;
      if (existing.owner !== input.reserveAddress || existing.mint !== input.mintAddress) {
        throw new WorkspaceReserveInitializationError("reserve_token_account_identity_mismatch", 409);
      }
      accountReady = hasApprovedConfidentialTransferAccount({
        owner: existing.owner,
        mint: existing.mint,
        extensions: extensions(existing).map((item) => ({
          __kind: item.__kind,
          approved: item.approved === true,
          allowConfidentialCredits: item.allowConfidentialCredits === true
        }))
      }, { owner: input.reserveAddress, mint: input.mintAddress });
    }

    const initialWorkspaceStatus = await inspectWorkspaceProgramState(input.rpc, {
      workspace: input.workspace, bump: input.workspaceBump, seed: input.workspaceSeed,
      workspaceId, authorityAddress: input.workspaceAuthority, programId: input.programId
    });
    if (initialWorkspaceStatus === "workspace_program_not_initialized") {
      return {
        status: "workspace_program_not_initialized", reserveAddress: input.reserveAddress,
        tokenAccount: input.reserveTokenAddress, confidentialTransferReady: accountReady,
        programReserveConfigured: false
      };
    }

    const initialReserveStatus = await inspectReserveProgramState(input.rpc, {
      workspace: input.workspace, reserveAuthority: input.reserveAddress, reserveToken: input.reserveTokenAddress,
      mint: input.mintAddress, programId: input.programId, reserveState: input.reserveState, reserveBump: input.reserveBump
    });
    const setupTransactionsNeeded = (accountReady ? 0 : 1) +
      (initialReserveStatus === "program_configured" ? 0 : 1);
    await assertGasTankCanFundReserveSetup({
      rpc: input.rpc,
      gasTankAddress,
      needsTokenAccountRent: !encoded.exists,
      needsReserveStateRent: initialReserveStatus !== "program_configured",
      transactionCount: setupTransactionsNeeded
    });

    if (!accountReady) {
      const confidentialMint = extensions(input.mintAccount).find((item) => item.__kind === "ConfidentialTransferMint");
      if (confidentialMint?.autoApproveNewAccounts !== true) {
        throw new WorkspaceReserveInitializationError("reserve_mint_authority_approval_required", 409);
      }
      await assertGasTankCanFundReserveSetup({
        rpc: input.rpc,
        gasTankAddress,
        needsTokenAccountRent: !encoded.exists,
        needsReserveStateRent: false,
        transactionCount: 1
      });
      const setup = await getCreateConfidentialTransferAccountInstructionPlan({
        payer: feePayerSigner,
        owner: input.signer,
        mint: address(input.mintAddress),
        token: address(input.reserveTokenAddress),
        rpc: input.rpc,
        elgamalKeypair: input.elgamal,
        aesKey: input.aesKey,
        includeConfidentialTransferFeeAmount: extensions(input.mintAccount).some((item) => item.__kind === "TransferFeeConfig")
      });
      const submitted = await executePlan(input.rpc, feePayerSigner, setup, async (signature) => {
        const tracked = await attachWorkspaceReserveSetupSignature(db, {
          workspaceId, phase: "account_setup", signature
        });
        if (tracked !== "attached" && tracked !== "duplicate") {
          throw new Error("Reserve account setup signature tracking conflicted.");
        }
      }, [input.signer]);
      const signature = submitted.signatures.at(-1);
      if (submitted.pending || submitted.trackingFailed) {
        return { status: "pending", reserveAddress: input.reserveAddress, tokenAccount: input.reserveTokenAddress, signature, phase: "account_setup" };
      }
      if (!submitted.successful || !signature) {
        if (signature) await clearWorkspaceReserveSetupSignature(db, {
          workspaceId, phase: "account_setup", signature
        });
        return { status: "retry_ready", reserveAddress: input.reserveAddress, tokenAccount: input.reserveTokenAddress, signature, phase: "account_setup" };
      }
      if (!await clearWorkspaceReserveSetupSignature(db, {
        workspaceId, phase: "account_setup", signature
      })) {
        return { status: "pending", reserveAddress: input.reserveAddress, tokenAccount: input.reserveTokenAddress, signature, phase: "account_setup" };
      }
    }

    const tokenState = await inspectTokenAccount(input);
    if (tokenState.status !== "account_ready" || !tokenState.confidentialTransferReady) {
      throw new WorkspaceReserveInitializationError("reserve_confidential_account_not_ready", 409);
    }
    const workspaceStatus = await inspectWorkspaceProgramState(input.rpc, {
      workspace: input.workspace, bump: input.workspaceBump, seed: input.workspaceSeed,
      workspaceId, authorityAddress: input.workspaceAuthority, programId: input.programId
    });
    if (workspaceStatus === "workspace_program_not_initialized") {
      return {
        status: "workspace_program_not_initialized", reserveAddress: input.reserveAddress,
        tokenAccount: tokenState.tokenAccount, confidentialTransferReady: true,
        publicBalanceBaseUnits: tokenState.publicBalanceBaseUnits,
        availableBalanceBaseUnits: tokenState.availableBalanceBaseUnits,
        pendingBalanceBaseUnits: tokenState.pendingBalanceBaseUnits, fundingState: tokenState.fundingState,
        programReserveConfigured: false
      };
    }
    const existingState = await inspectReserveProgramState(input.rpc, {
      workspace: input.workspace, reserveAuthority: input.reserveAddress, reserveToken: tokenState.tokenAccount,
      mint: input.mintAddress, programId: input.programId, reserveState: input.reserveState, reserveBump: input.reserveBump
    });
    if (existingState === "program_configured") {
      await verifyGasTankBalanceReadable(input.rpc, gasTankAddress);
      return {
        status: "program_configured", reserveAddress: input.reserveAddress,
        tokenAccount: tokenState.tokenAccount, confidentialTransferReady: true,
        publicBalanceBaseUnits: tokenState.publicBalanceBaseUnits,
        availableBalanceBaseUnits: tokenState.availableBalanceBaseUnits,
        pendingBalanceBaseUnits: tokenState.pendingBalanceBaseUnits, fundingState: tokenState.fundingState,
        programReserveConfigured: true
      };
    }

    await assertGasTankCanFundReserveSetup({
      rpc: input.rpc,
      gasTankAddress,
      needsTokenAccountRent: false,
      needsReserveStateRent: true,
      transactionCount: 1
    });
    const ix = configureWorkspaceReserveInstruction({
      programId: input.programId, authorityAddress: input.workspaceAuthority, workspace: input.workspace,
      payerAddress: gasTankAddress, reserveState: input.reserveState, reserveAuthority: input.reserveAddress,
      reserveToken: tokenState.tokenAccount, mint: input.mintAddress
    });
    const configured = await executePlan(input.rpc, feePayerSigner, singleInstructionPlan(ix), async (signature) => {
      const tracked = await attachWorkspaceReserveSetupSignature(db, {
        workspaceId, phase: "program_configure", signature
      });
      if (tracked !== "attached" && tracked !== "duplicate") {
        throw new Error("Reserve program configuration signature tracking conflicted.");
      }
    }, [input.signer]);
    const signature = configured.signatures.at(-1);
    if (configured.pending || configured.trackingFailed) {
      return { status: "pending", reserveAddress: input.reserveAddress, tokenAccount: tokenState.tokenAccount, signature, phase: "program_configure" };
    }
    if (!configured.successful || !signature) {
      if (signature) await clearWorkspaceReserveSetupSignature(db, {
        workspaceId, phase: "program_configure", signature
      });
      return { status: "retry_ready", reserveAddress: input.reserveAddress, tokenAccount: tokenState.tokenAccount, signature, phase: "program_configure" };
    }
    if (!await clearWorkspaceReserveSetupSignature(db, {
      workspaceId, phase: "program_configure", signature
    })) {
      return { status: "pending", reserveAddress: input.reserveAddress, tokenAccount: tokenState.tokenAccount, signature, phase: "program_configure" };
    }
    const verified = await inspectReserveProgramState(input.rpc, {
      workspace: input.workspace, reserveAuthority: input.reserveAddress, reserveToken: tokenState.tokenAccount,
      mint: input.mintAddress, programId: input.programId, reserveState: input.reserveState, reserveBump: input.reserveBump
    });
    if (verified !== "program_configured") {
      throw new WorkspaceReserveInitializationError("reserve_program_configuration_not_verified", 503);
    }
    await verifyGasTankBalanceReadable(input.rpc, gasTankAddress);
    return {
      status: "program_configured", reserveAddress: input.reserveAddress,
      tokenAccount: tokenState.tokenAccount, confidentialTransferReady: true,
      publicBalanceBaseUnits: tokenState.publicBalanceBaseUnits,
      availableBalanceBaseUnits: tokenState.availableBalanceBaseUnits,
      pendingBalanceBaseUnits: tokenState.pendingBalanceBaseUnits, fundingState: tokenState.fundingState,
      programReserveConfigured: true
    };
  }, { requireGasTankFeePayer: true });
  return result as WorkspaceConfidentialReserveResult;
}
