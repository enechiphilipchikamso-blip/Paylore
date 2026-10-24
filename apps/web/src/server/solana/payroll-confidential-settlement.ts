import "server-only";

import { createHash } from "node:crypto";
import {
  AccountRole, address, blockhash, createKeyPairSignerFromBytes, createSolanaRpc,
  createTransactionMessage, createTransactionPlanExecutorWithConcurrentLeaves,
  createTransactionPlanner, fetchEncodedAccount, getAddressEncoder,
  getBase64EncodedWireTransaction, getProgramDerivedAddress, isSome,
  partiallySignTransactionMessageWithSigners,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  singleInstructionPlan, type Instruction, type InstructionPlan, type Signature
} from "@solana/kit";
import {
  fetchMint, fetchToken, findAssociatedTokenPda, getConfidentialDepositInstruction,
  TOKEN_2022_PROGRAM_ADDRESS
} from "@solana-program/token-2022";
import {
  deriveConfidentialKeys, fetchConfidentialTransferBalance,
  getApplyConfidentialPendingBalanceInstructionFromToken,
  getConfidentialTransferInstructionPlan, getCreateConfidentialTransferAccountInstructionPlan
} from "@solana-program/token-2022/confidential";
import { closeContextStateProof, ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS } from "@solana-program/zk-elgamal-proof";
import { AeKey, ElGamalKeypair, ElGamalSecretKey } from "@solana/zk-sdk/bundler";
import {
  appendPayrollSettlementContextSignature, attachPayrollSettlementSignature,
  beginPayrollSettlementAttempt, clearPayrollSettlementProofContexts,
  getContributorConfidentialAccount, getPayrollClaimCreationEvidence,
  getWorkspacePayrollRun, getWorkspaceReserve, recordVerifiedPayrollClaimSettlement,
  releaseFailedPayrollSettlementAttempt, releaseUnsubmittedPayrollSettlementAttempt,
  setPayrollSettlementProofContexts, updatePendingPayrollSettlementBalanceSnapshot,
  type Database
} from "@paylore/database";
import { loadPayloreConfig } from "../config";
import { withWorkspaceReserveKey } from "../reserve";
import { verifyPayrollClaimTransaction } from "./payroll-program-verification";
import {
  bindAmountBoundClaimedStateToConfidentialTransfer, classifyTransactionFinality, getProofContextAddresses
} from "./payroll-confidential-settlement-policy";
import { reconcileFinalizedSettlement } from "./payroll-settlement-reconciliation";
import { derivePayrollAmountCommitmentMaterial } from "./payroll-amount-commitment";
import { bindAmountCommitmentProof } from "./payroll-amount-proof-binding";
import {
  advanceConfidentialSequence,
  assertConfidentialStepAllowed,
  createConfidentialSequenceProgress
} from "../../components/workspace/confidential-operation-sequence";

const DEVNET_RPC_URL = "https://api.devnet.solana.com";
const FINALITY_TIMEOUT_MS = 120_000;
const INSTRUCTIONS_SYSVAR = address("Sysvar1nstructions1111111111111111111111111");
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const encoder = new TextEncoder();

type Token = Awaited<ReturnType<typeof fetchToken>>["data"];
type Mint = Awaited<ReturnType<typeof fetchMint>>["data"];
type DerivedKeys = Awaited<ReturnType<typeof deriveConfidentialKeys>>;
type Finality = "finalized" | "failed" | "pending";

export type PayrollSettlementResult = {
  status: "claimed" | "already_settled" | "pending" | "retry_ready" | "workspace_busy" | "state_conflict";
  signature?: string;
  amountBaseUnits?: string;
  proofDurationMs?: number;
  warning?: "proof_context_cleanup_pending";
};

export class PayrollConfidentialSettlementError extends Error {
  constructor(readonly code: string, readonly statusCode: number) {
    super(code);
    this.name = "PayrollConfidentialSettlementError";
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
function discriminator(value: string): Uint8Array {
  return createHash("sha256").update(value).digest().subarray(0, 8);
}
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}
function decodeBase58(value: string): Uint8Array {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let decoded = 0n;
  for (const char of value) {
    const digit = alphabet.indexOf(char);
    if (digit < 0) throw new Error("Finalized instruction data is malformed.");
    decoded = decoded * 58n + BigInt(digit);
  }
  const bytes: number[] = [];
  while (decoded > 0n) { bytes.unshift(Number(decoded & 255n)); decoded >>= 8n; }
  for (const char of value) { if (char !== "1") break; bytes.unshift(0); }
  return Uint8Array.from(bytes);
}
function decodeAccountData(value: unknown): Buffer | null {
  if (!Array.isArray(value) || typeof value[0] !== "string" || value[1] !== "base64") return null;
  const bytes = Buffer.from(value[0], "base64");
  return bytes.toString("base64") === value[0] ? bytes : null;
}
function extensions(token: Token | Mint): readonly { __kind: string }[] {
  return isSome(token.extensions) ? token.extensions.value : [];
}
function confidentialExtension(token: Token): Record<string, unknown> | null {
  const item = extensions(token).find((value) => value.__kind === "ConfidentialTransferAccount");
  return item ? item as unknown as Record<string, unknown> : null;
}
function assertConfidentialAccount(token: Token, owner: string, mint: string, code: string): void {
  const extension = confidentialExtension(token);
  if (token.owner !== owner || token.mint !== mint || !extension ||
      extension.approved !== true || extension.allowConfidentialCredits !== true) {
    throw new PayrollConfidentialSettlementError(code, 409);
  }
}
function rpcEndpoint(): string {
  const config = loadPayloreConfig();
  const url = new URL(config.PAYLORE_RPC_PRIMARY_URL || DEVNET_RPC_URL);
  if (config.PAYLORE_RPC_PRIMARY_PROVIDER === "helius" && config.PAYLORE_RPC_PRIMARY_API_KEY) {
    url.searchParams.set("api-key", config.PAYLORE_RPC_PRIMARY_API_KEY);
  }
  return url.toString();
}
async function waitForFinality(rpc: ReturnType<typeof createSolanaRpc>, sig: Signature): Promise<Finality> {
  const deadline = Date.now() + FINALITY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const response = await rpc.getSignatureStatuses([sig], { searchTransactionHistory: true }).send();
    const finality = classifyTransactionFinality(response.value[0]);
    if (finality !== "pending") return finality;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return "pending";
}
async function executePlan(
  rpc: ReturnType<typeof createSolanaRpc>,
  signer: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>,
  plan: InstructionPlan,
  submitted?: (signature: string) => Promise<void>
): Promise<{ successful: boolean; pending: boolean; signatures: string[]; trackingFailed: boolean }> {
  const planner = createTransactionPlanner({
    createTransactionMessage: () =>
      setTransactionMessageFeePayerSigner(signer, createTransactionMessage({ version: 0 })),
    onTransactionMessageUpdated: async (message) => {
      const latest = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
      return setTransactionMessageLifetimeUsingBlockhash({
        blockhash: blockhash(latest.value.blockhash),
        lastValidBlockHeight: BigInt(latest.value.lastValidBlockHeight)
      }, message);
    }
  });
  const planned = await planner(plan);
  const signatures: string[] = [];
  let trackingFailed = false;
  const executor = createTransactionPlanExecutorWithConcurrentLeaves({
    executeTransactionMessage: async (_context, message) => {
      const signed = await partiallySignTransactionMessageWithSigners(message);
      const encoded = getBase64EncodedWireTransaction(signed);
      const sig = await rpc.sendTransaction(encoded, {
        encoding: "base64", preflightCommitment: "confirmed", maxRetries: 3
      }).send();
      const text = String(sig);
      signatures.push(text);
      if (submitted) {
        try { await submitted(text); }
        catch { trackingFailed = true; }
      }
      const finality = await waitForFinality(rpc, sig);
      if (finality === "pending") throw new FinalityPendingError(text);
      if (finality === "failed") throw new FinalityFailedError(text);
      return { signature: sig };
    }
  });
  try {
    await executor(planned);
    return { successful: !trackingFailed, pending: false, signatures, trackingFailed };
  } catch (error) {
    if (error instanceof FinalityPendingError) return { successful: false, pending: true, signatures, trackingFailed };
    if (error instanceof FinalityFailedError) return { successful: false, pending: false, signatures, trackingFailed };
    throw error;
  }
}
export async function cleanupProofContexts(
  db: Database,
  rpc: ReturnType<typeof createSolanaRpc>,
  signer: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>,
  input: { workspaceId: string; runId: string; allocationId: string; addresses: string[] }
): Promise<boolean> {
  let allContextsResolved = true;
  for (const addressText of new Set(input.addresses)) {
    try {
      const encoded = await fetchEncodedAccount(rpc, address(addressText));
      if (!encoded.exists) continue;
      if (encoded.owner !== ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS) {
        allContextsResolved = false;
        continue;
      }
      const ix = closeContextStateProof({
        contextState: address(addressText),
        authority: signer,
        destination: address(signer.address)
      });
      const result = await executePlan(rpc, signer, singleInstructionPlan(ix));
      if (!result.successful || result.pending || result.trackingFailed) {
        allContextsResolved = false;
      }
    } catch {
      allContextsResolved = false;
    }
  }
  // Durable tracking is retained unless every known context is absent or finalized closed.
  return allContextsResolved ? clearPayrollSettlementProofContexts(db, input) : false;
}
export async function proofSetupFinality(
  rpc: ReturnType<typeof createSolanaRpc>,
  signatures: string[]
): Promise<Finality> {
  if (signatures.length === 0) return "pending";
  try {
    for (const value of signatures) {
      const status = (await rpc.getSignatureStatuses([value as Signature], { searchTransactionHistory: true }).send()).value[0];
      const finality = classifyTransactionFinality(status);
      if (finality !== "finalized") return finality;
    }
    return "finalized";
  } catch {
    return "pending";
  }
}
async function readReserveBalance(
  rpc: ReturnType<typeof createSolanaRpc>, tokenAddress: string, secret: ElGamalSecretKey, aesKey: AeKey
) {
  const [token, confidential] = await Promise.all([
    fetchToken(rpc, address(tokenAddress)),
    fetchConfidentialTransferBalance({ token: address(tokenAddress), rpc, elgamalSecretKey: secret, aesKey })
  ]);
  return { token: token.data, confidential };
}
async function ensureReserveConfidentialAccount(input: {
  rpc: ReturnType<typeof createSolanaRpc>;
  signer: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>;
  mint: string;
  mintAccount: Mint;
  tokenAddress: string;
  elgamal: ElGamalKeypair;
  aesKey: AeKey;
}): Promise<Token> {
  const encoded = await fetchEncodedAccount(input.rpc, address(input.tokenAddress));
  const existing = encoded.exists ? (await fetchToken(input.rpc, address(input.tokenAddress))).data : null;
  if (!existing || !confidentialExtension(existing)) {
    const extension = extensions(input.mintAccount).find((value) => value.__kind === "ConfidentialTransferMint")
      as unknown as { autoApproveNewAccounts?: boolean } | undefined;
    if (!extension) throw new PayrollConfidentialSettlementError("confidential_mint_unavailable", 503);
    if (extension.autoApproveNewAccounts !== true) {
      throw new PayrollConfidentialSettlementError("reserve_account_requires_mint_authority_approval", 409);
    }
    const plan = await getCreateConfidentialTransferAccountInstructionPlan({
      payer: input.signer, owner: input.signer, mint: address(input.mint), token: address(input.tokenAddress),
      rpc: input.rpc, elgamalKeypair: input.elgamal, aesKey: input.aesKey,
      includeConfidentialTransferFeeAmount: extensions(input.mintAccount).some((value) => value.__kind === "TransferFeeConfig")
    });
    const result = await executePlan(input.rpc, input.signer, plan);
    if (!result.successful || result.pending || result.trackingFailed) {
      throw new PayrollConfidentialSettlementError("reserve_confidential_account_setup_failed", 503);
    }
  }
  const token = (await fetchToken(input.rpc, address(input.tokenAddress))).data;
  assertConfidentialAccount(token, input.signer.address, input.mint, "reserve_confidential_account_not_ready");
  return token;
}
async function deriveWorkspaceReserve(input: { authority: string; workspaceId: string; programId: string }) {
  const seed = createHash("sha256").update("paylore:workspace:v1:" + input.workspaceId).digest();
  const [workspace] = await getProgramDerivedAddress({
    programAddress: address(input.programId),
    seeds: [encoder.encode("workspace"), getAddressEncoder().encode(address(input.authority)), seed]
  });
  const [reserveState] = await getProgramDerivedAddress({
    programAddress: address(input.programId), seeds: [encoder.encode("reserve"), getAddressEncoder().encode(workspace)]
  });
  return { workspace, reserveState };
}
function configureReserveInstruction(input: {
  programId: string; authority: string; workspace: string; reserveState: string;
  reserveAuthority: string; reserveToken: string; mint: string;
}): Instruction {
  return {
    programAddress: address(input.programId),
    accounts: [
      { address: address(input.authority), role: AccountRole.READONLY },
      { address: address(input.workspace), role: AccountRole.READONLY },
      { address: address(input.reserveState), role: AccountRole.WRITABLE },
      { address: address(input.reserveAuthority), role: AccountRole.WRITABLE_SIGNER },
      { address: address(input.reserveToken), role: AccountRole.READONLY },
      { address: address(input.mint), role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM, role: AccountRole.READONLY }
    ],
    data: discriminator("global:configure_workspace_reserve")
  };
}
function markClaimedInstruction(input: {
  programId: string; contributor: string; workspace: string; reserveState: string;
  reserveAuthority: string; reserveToken: string; mint: string; destination: string; claim: string;
  amountCommitmentContext: string;
}): Instruction {
  return {
    programAddress: address(input.programId),
    accounts: [
      { address: address(input.contributor), role: AccountRole.READONLY },
      { address: address(input.workspace), role: AccountRole.READONLY },
      { address: address(input.reserveState), role: AccountRole.WRITABLE },
      { address: address(input.reserveAuthority), role: AccountRole.READONLY_SIGNER },
      { address: address(input.reserveToken), role: AccountRole.READONLY },
      { address: address(input.mint), role: AccountRole.READONLY },
      { address: address(input.destination), role: AccountRole.WRITABLE },
      { address: address(input.claim), role: AccountRole.WRITABLE },
      { address: INSTRUCTIONS_SYSVAR, role: AccountRole.READONLY },
      { address: address(input.amountCommitmentContext), role: AccountRole.READONLY }
    ],
    data: discriminator("global:mark_claimed")
  };
}
function finalizeClaimedInstruction(input: {
  programId: string; contributor: string; workspace: string; reserveState: string;
  reserveAuthority: string; claim: string;
}): Instruction {
  return {
    programAddress: address(input.programId),
    accounts: [
      { address: address(input.contributor), role: AccountRole.READONLY },
      { address: address(input.workspace), role: AccountRole.READONLY },
      { address: address(input.reserveState), role: AccountRole.READONLY },
      { address: address(input.reserveAuthority), role: AccountRole.READONLY_SIGNER },
      { address: address(input.claim), role: AccountRole.WRITABLE }
    ],
    data: discriminator("global:finalize_claimed")
  };
}
function keysOf(message: Record<string, unknown>): string[] {
  const values = Array.isArray(message.accountKeys) ? message.accountKeys : [];
  return values.map((value) => {
    if (typeof value === "string") return value;
    const pubkey = object(value)?.pubkey;
    return typeof pubkey === "string" ? pubkey : "";
  });
}
function accountsOf(instruction: Record<string, unknown>, keys: string[]): string[] {
  return (Array.isArray(instruction.accounts) ? instruction.accounts : []).map((value) =>
    typeof value === "number" ? keys[value] ?? "" : typeof value === "string" ? value : ""
  );
}
function programOf(instruction: Record<string, unknown>, keys: string[]): string {
  if (typeof instruction.programId === "string") return instruction.programId;
  return typeof instruction.programIdIndex === "number" ? keys[instruction.programIdIndex] ?? "" : "";
}
type FinalizedClaimState = "unclaimed" | "settlement_pending" | "claimed" | "recovered";

async function readFinalizedClaimState(input: {
  rpc: ReturnType<typeof createSolanaRpc>;
  programId: string;
  workspace: string;
  contributor: string;
  claim: string;
  claimId: string;
  allocationCommitment: string;
  amountCommitment: string;
}): Promise<FinalizedClaimState> {
  if (!/^[0-9a-f]{64}$/i.test(input.claimId) ||
      !/^[0-9a-f]{64}$/i.test(input.allocationCommitment) ||
      !/^[0-9a-f]{64}$/i.test(input.amountCommitment)) {
    throw new PayrollConfidentialSettlementError("settlement_claim_commitment_invalid", 409);
  }
  const claimId = Uint8Array.from(input.claimId.match(/.{2}/g)!, (hex) => Number.parseInt(hex, 16));
  const commitment = Uint8Array.from(input.allocationCommitment.match(/.{2}/g)!, (hex) => Number.parseInt(hex, 16));
  const amountCommitment = Uint8Array.from(input.amountCommitment.match(/.{2}/g)!, (hex) => Number.parseInt(hex, 16));
  const [derivedClaim, bump] = await getProgramDerivedAddress({
    programAddress: address(input.programId),
    seeds: [encoder.encode("claim"), getAddressEncoder().encode(address(input.workspace)),
      getAddressEncoder().encode(address(input.contributor)), claimId]
  });
  const response = await input.rpc.getAccountInfo(address(input.claim), {
    commitment: "finalized", encoding: "base64"
  }).send();
  const account = object(response.value);
  const data = decodeAccountData(account?.data);
  if (derivedClaim !== input.claim || !account || account.owner !== input.programId ||
      account.executable === true || !data || data.length !== 170 ||
      !sameBytes(data.subarray(0, 8), discriminator("account:ClaimState")) ||
      !sameBytes(data.subarray(8, 40), getAddressEncoder().encode(address(input.workspace))) ||
      !sameBytes(data.subarray(40, 72), getAddressEncoder().encode(address(input.contributor))) ||
      !sameBytes(data.subarray(72, 104), claimId) ||
      !sameBytes(data.subarray(104, 136), commitment) ||
      !sameBytes(data.subarray(136, 168), amountCommitment) ||
      data[169] !== bump || data[168] > 3) {
    throw new PayrollConfidentialSettlementError("settlement_claim_state_not_verified", 409);
  }
  return data[168] === 0 ? "unclaimed" : data[168] === 1 ? "claimed" : data[168] === 2 ? "recovered" : "settlement_pending";
}

async function verifyFinalizedSettlement(input: {
  rpc: ReturnType<typeof createSolanaRpc>; signature: string; programId: string; workspace: string;
  reserveState: string; reserveAuthority: string; reserveToken: string; contributor: string;
  destination: string; mint: string; claim: string; claimId: string; allocationCommitment: string;
}): Promise<void> {
  const txResult = await input.rpc.getTransaction(input.signature as Signature, {
    encoding: "json", commitment: "finalized", maxSupportedTransactionVersion: 0
  }).send();
  const tx = object(txResult);
  const meta = object(tx?.meta);
  const body = object(tx?.transaction);
  const message = object(body?.message);
  const signatures = body?.signatures;
  const keys = message ? keysOf(message) : [];
  const instructions = message?.instructions;
  if (!tx || !meta || meta.err !== null || typeof tx.slot !== "number" ||
      !Array.isArray(signatures) || !signatures.includes(input.signature) ||
      keys[0] !== input.reserveAuthority || !Array.isArray(instructions)) {
    throw new PayrollConfidentialSettlementError("settlement_transaction_not_finalized", 409);
  }
  let transferIndex = -1;
  let markIndex = -1;
  let transfers = 0;
  let marks = 0;
  for (const [index, raw] of instructions.entries()) {
    const ix = object(raw);
    if (!ix) continue;
    const programId = programOf(ix, keys);
    const accounts = accountsOf(ix, keys);
    const data = typeof ix.data === "string" ? decodeBase58(ix.data) : null;
    if (programId === TOKEN_2022_PROGRAM_ADDRESS && data && data.length >= 2 && data[0] === 27 && data[1] === 7 &&
        accounts[0] === input.reserveToken && accounts[1] === input.mint && accounts[2] === input.destination) {
      transferIndex = index; transfers++;
    }
    if (programId === input.programId && data && sameBytes(data, discriminator("global:mark_claimed")) &&
        accounts.length === 9 && accounts[0] === input.contributor && accounts[1] === input.workspace &&
        accounts[2] === input.reserveState && accounts[3] === input.reserveAuthority &&
        accounts[4] === input.reserveToken && accounts[5] === input.mint && accounts[6] === input.destination &&
        accounts[7] === input.claim && accounts[8] === INSTRUCTIONS_SYSVAR) {
      markIndex = index; marks++;
    }
  }
  if (transfers !== 1 || marks !== 1 || markIndex !== transferIndex + 1) {
    throw new PayrollConfidentialSettlementError("settlement_transfer_binding_invalid", 409);
  }
  if (!/^[0-9a-f]{64}$/i.test(input.claimId) || !/^[0-9a-f]{64}$/i.test(input.allocationCommitment)) {
    throw new PayrollConfidentialSettlementError("settlement_claim_commitment_invalid", 409);
  }
  const claimId = Uint8Array.from(input.claimId.match(/.{2}/g)!, (hex) => Number.parseInt(hex, 16));
  const commitment = Uint8Array.from(input.allocationCommitment.match(/.{2}/g)!, (hex) => Number.parseInt(hex, 16));
  const [derivedClaim, bump] = await getProgramDerivedAddress({
    programAddress: address(input.programId),
    seeds: [encoder.encode("claim"), getAddressEncoder().encode(address(input.workspace)),
      getAddressEncoder().encode(address(input.contributor)), claimId]
  });
  const response = await input.rpc.getAccountInfo(address(input.claim), { commitment: "finalized", encoding: "base64" }).send();
  const account = object(response.value);
  const data = decodeAccountData(account?.data);
  if (derivedClaim !== input.claim || !account || account.owner !== input.programId ||
      account.executable === true || !data || data.length !== 170 ||
      !sameBytes(data.subarray(0, 8), discriminator("account:ClaimState")) ||
      !sameBytes(data.subarray(8, 40), getAddressEncoder().encode(address(input.workspace))) ||
      !sameBytes(data.subarray(40, 72), getAddressEncoder().encode(address(input.contributor))) ||
      !sameBytes(data.subarray(72, 104), claimId) ||
      !sameBytes(data.subarray(104, 136), commitment) ||
      !sameBytes(data.subarray(136, 168), amountCommitment) ||
      (data[168] !== 1 && data[168] !== 3) || data[169] !== bump) {
    throw new PayrollConfidentialSettlementError("settlement_claim_state_not_verified", 409);
  }
}
async function reconcileSettlement(
  db: Database, rpc: ReturnType<typeof createSolanaRpc>,
  signer: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>,
  secret: ElGamalSecretKey, aesKey: AeKey,
  input: {
    workspaceId: string; runId: string; allocationId: string; contributorUserId: string;
    contributor: string; claim: string; claimId: string; creationSignature: string; settlementSignature: string;
    amount: string; mint: string; programId: string; authority: string; commitment: string;
    workspace: string; reserveState: string; reserveToken: string; destination: string; sourceBefore: string;
    proofContexts: string[]; proofDurationMs?: number;
  }
): Promise<PayrollSettlementResult> {
  const [statusResult, balances] = await Promise.all([
    rpc.getSignatureStatuses([input.settlementSignature as Signature], { searchTransactionHistory: true }).send(),
    readReserveBalance(rpc, input.reserveToken, secret, aesKey)
  ]);
  const status = statusResult.value[0];
  const sourceAfter = balances.confidential.availableBalance.toString();
  const finality = classifyTransactionFinality(status);
  if (finality === "pending") {
    return { status: "pending", signature: input.settlementSignature, proofDurationMs: input.proofDurationMs };
  }
  if (finality === "failed") {
    if (sourceAfter !== input.sourceBefore) {
      return { status: "pending", signature: input.settlementSignature, proofDurationMs: input.proofDurationMs };
    }
    const cleaned = await cleanupProofContexts(db, rpc, signer, {
      workspaceId: input.workspaceId, runId: input.runId, allocationId: input.allocationId, addresses: input.proofContexts
    });
    if (!cleaned) {
      return { status: "pending", signature: input.settlementSignature, warning: "proof_context_cleanup_pending" };
    }
    let claimState: FinalizedClaimState;
    try {
      claimState = await readFinalizedClaimState({
        rpc, programId: input.programId, workspace: input.workspace, contributor: input.contributor,
        claim: input.claim, claimId: input.claimId, allocationCommitment: input.commitment
      });
    } catch {
      return { status: "pending", signature: input.settlementSignature };
    }
    if (claimState !== "unclaimed") {
      return { status: "state_conflict", signature: input.settlementSignature };
    }
    const released = await releaseFailedPayrollSettlementAttempt(db, {
      workspaceId: input.workspaceId, runId: input.runId, allocationId: input.allocationId,
      settlementSignature: input.settlementSignature
    });
    return released ? { status: "retry_ready", signature: input.settlementSignature } : { status: "pending", signature: input.settlementSignature };
  }
  await verifyFinalizedSettlement({
    rpc, signature: input.settlementSignature, programId: input.programId, workspace: input.workspace,
    reserveState: input.reserveState, reserveAuthority: signer.address, reserveToken: input.reserveToken,
    contributor: input.contributor, destination: input.destination, mint: input.mint,
    claim: input.claim, claimId: input.claimId, allocationCommitment: input.commitment
  });
  if (!matchesExactConfidentialDebit({
    amountBaseUnits: input.amount,
    sourceAvailableBefore: input.sourceBefore,
    sourceAvailableAfter: sourceAfter
  })) {
    return { status: "pending", signature: input.settlementSignature, proofDurationMs: input.proofDurationMs };
  }
  const result = await reconcileFinalizedSettlement({
    signature: input.settlementSignature, amountBaseUnits: input.amount,
    sourceAvailableBefore: input.sourceBefore, proofDurationMs: input.proofDurationMs
  }, {
    getFinality: async () => finality,
    verifyFinalizedTransaction: async () => verifyFinalizedSettlement({
      rpc, signature: input.settlementSignature, programId: input.programId, workspace: input.workspace,
      reserveState: input.reserveState, reserveAuthority: signer.address, reserveToken: input.reserveToken,
      contributor: input.contributor, destination: input.destination, mint: input.mint,
      claim: input.claim, claimId: input.claimId, allocationCommitment: input.commitment
    }),
    readFinalizedSourceAvailable: async () => sourceAfter,
    readFinalizedClaimState: async () => readFinalizedClaimState({
      rpc, programId: input.programId, workspace: input.workspace, contributor: input.contributor,
      claim: input.claim, claimId: input.claimId, allocationCommitment: input.commitment
    }),
    finalizeClaimed: async () => {
      const tx = await executePlan(rpc, signer, singleInstructionPlan(finalizeClaimedInstruction({
        programId: input.programId, contributor: input.contributor, workspace: input.workspace,
        reserveState: input.reserveState, reserveAuthority: signer.address, claim: input.claim
      })));
      return tx.successful && !tx.pending && !tx.trackingFailed ? "finalized" : "pending";
    },
    attachSignature: async () => {
      const tx = await attachPayrollSettlementSignature(db, {
        workspaceId: input.workspaceId, runId: input.runId, allocationId: input.allocationId,
        claimAddress: input.claim, claimCreationSignature: input.creationSignature,
        settlementSignature: input.settlementSignature, sourceAvailableBefore: input.sourceBefore
      });
      return tx.status === "attached" || tx.status === "duplicate" ? tx.status : "conflict";
    },
    recordLedger: async () => {
      const tx = await recordVerifiedPayrollClaimSettlement(db, {
        workspaceId: input.workspaceId, runId: input.runId, allocationId: input.allocationId,
        contributorUserId: input.contributorUserId, claimAddress: input.claim,
        claimCreationSignature: input.creationSignature, settlementSignature: input.settlementSignature,
        sourceTokenAccount: input.reserveToken, destinationTokenAccount: input.destination, mint: input.mint,
        programId: input.programId, authorityAddress: input.authority,
        sourceAvailableBefore: input.sourceBefore, sourceAvailableAfter: sourceAfter
      });
      return tx.status === "claimed" || tx.status === "duplicate" ? tx.status : "conflict";
    },
    cleanupProofContexts: () => cleanupProofContexts(db, rpc, signer, {
      workspaceId: input.workspaceId, runId: input.runId, allocationId: input.allocationId,
      addresses: input.proofContexts
    })
  });
  return {
    status: result.status, signature: result.signature, amountBaseUnits: result.amountBaseUnits,
    proofDurationMs: result.proofDurationMs,
    ...("warning" in result && result.warning ? { warning: result.warning } : {})
  };
  };
}

/** Settles one committed allocation and reports payment only after atomic PDA state and private reserve debit reconciliation. */
export async function settleContributorPayrollAllocation(
  db: Database,
  input: {
    workspaceId: string; runId: string; allocationId: string; contributorId: string;
    contributorAddress: string; contributorUserId: string;
  }
): Promise<PayrollSettlementResult> {
  const payroll = await getWorkspacePayrollRun(db, input.workspaceId, input.runId);
  const allocation = payroll?.allocations.find((row) => row.id === input.allocationId);
  if (!payroll || !allocation || allocation.contributorId !== input.contributorId ||
      allocation.contributorWalletAddress !== input.contributorAddress) {
    throw new PayrollConfidentialSettlementError("payroll_allocation_not_found", 404);
  }
  if (!/^(0|[1-9][0-9]*)$/.test(allocation.amountBaseUnits) || BigInt(allocation.amountBaseUnits) <= 0n ||
      !/^[0-9a-f]{64}$/i.test(allocation.claimId)) {
    throw new PayrollConfidentialSettlementError("payroll_allocation_amount_invalid", 409);
  }
  if (!allocation.claimAddress || !allocation.transactionSignature) {
    throw new PayrollConfidentialSettlementError("payroll_claim_creation_unverified", 409);
  }
  const config = loadPayloreConfig();
  const mint = config.PAYLORE_WRAPPED_USDC_MINT;
  const programId = config.PAYLORE_PAYROLL_PROGRAM_ID;
  if (!mint) throw new PayrollConfidentialSettlementError("confidential_mint_unavailable", 503);
  if (!programId) throw new PayrollConfidentialSettlementError("payroll_program_not_configured", 503);
  if (!config.PAYLORE_PAYROLL_AMOUNT_COMMITMENT_SECRET) {
    throw new PayrollConfidentialSettlementError("payroll_amount_commitment_not_configured", 503);
  }
  const contributorAccount = await getContributorConfidentialAccount(db, input.workspaceId, input.contributorId);
  if (!contributorAccount || contributorAccount.status !== "ready" ||
      contributorAccount.ownerWalletAddress !== input.contributorAddress) {
    throw new PayrollConfidentialSettlementError("contributor_confidential_account_not_ready", 409);
  }
  const [destination] = await findAssociatedTokenPda({
    owner: address(input.contributorAddress), mint: address(mint), tokenProgram: TOKEN_2022_PROGRAM_ADDRESS
  });
  if (contributorAccount.tokenAccountAddress !== destination) {
    throw new PayrollConfidentialSettlementError("contributor_confidential_account_not_ready", 409);
  }
  const evidence = await getPayrollClaimCreationEvidence(db, {
    workspaceId: input.workspaceId, runId: input.runId, claimId: allocation.claimId, claimAddress: allocation.claimAddress
  });
  if (!evidence || evidence.transactionSignature !== allocation.transactionSignature || evidence.programId !== programId) {
    throw new PayrollConfidentialSettlementError("payroll_claim_creation_unverified", 409);
  }

  return withWorkspaceReserveKey(db, input.workspaceId, async (privateBytes) => {
    const reserve = await getWorkspaceReserve(db, input.workspaceId);
    const signer = await createKeyPairSignerFromBytes(privateBytes);
    if (!reserve || reserve.address !== signer.address) {
      throw new PayrollConfidentialSettlementError("workspace_reserve_key_mismatch", 503);
    }
    const derived: DerivedKeys = await deriveConfidentialKeys({ signer });
    const secret = ElGamalSecretKey.fromBytes(derived.elgamalKeypair.secretKey);
    const elgamal = ElGamalKeypair.fromSecretKey(secret);
    const aesKey = AeKey.fromBytes(derived.aeKey);
    try {
      const rpc = createSolanaRpc(rpcEndpoint());
      const mintAddress = address(mint);
      const mintAccount = (await fetchMint(rpc, mintAddress)).data;
      if (mintAccount.decimals !== 6 || !extensions(mintAccount).some((value) => value.__kind === "ConfidentialTransferMint")) {
        throw new PayrollConfidentialSettlementError("confidential_mint_unavailable", 503);
      }
      const [reserveToken] = await findAssociatedTokenPda({
        owner: address(signer.address), mint: mintAddress, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS
      });
      const { workspace, reserveState } = await deriveWorkspaceReserve({
        authority: evidence.authorityAddress, workspaceId: input.workspaceId, programId
      });
      if (allocation.status === "claimed") {
        return { status: "already_settled", signature: allocation.settlementSignature ?? undefined, amountBaseUnits: allocation.amountBaseUnits };
      }
      if (allocation.status === "recovered" || allocation.status === "cancelled") {
        throw new PayrollConfidentialSettlementError("payroll_claim_state_conflict", 409);
      }
      if (allocation.status === "settlement_pending") {
        const proofContexts = allocation.settlementProofContextAddresses ?? [];
        if (allocation.settlementSignature) {
          return reconcileSettlement(db, rpc, signer, secret, aesKey, {
            workspaceId: input.workspaceId, runId: input.runId, allocationId: input.allocationId,
            contributorUserId: input.contributorUserId, contributor: input.contributorAddress,
            claim: allocation.claimAddress, claimId: allocation.claimId,
            creationSignature: allocation.transactionSignature, settlementSignature: allocation.settlementSignature,
            amount: allocation.amountBaseUnits, mint, programId, authority: evidence.authorityAddress,
            commitment: evidence.allocationCommitment, workspace, reserveState, reserveToken, destination,
            sourceBefore: allocation.settlementSourceAvailableBefore ?? "0", proofContexts
          });
        }
        const setupStatus = await proofSetupFinality(rpc, allocation.settlementContextSignatures ?? []);
        if (setupStatus === "pending") return { status: "pending" };
        const cleaned = await cleanupProofContexts(db, rpc, signer, {
          workspaceId: input.workspaceId, runId: input.runId, allocationId: input.allocationId, addresses: proofContexts
        });
        if (!cleaned) return { status: "pending", warning: "proof_context_cleanup_pending" };
        let claimState: FinalizedClaimState;
        try {
          claimState = await readFinalizedClaimState({
            rpc, programId, workspace, contributor: input.contributorAddress, claim: allocation.claimAddress,
            claimId: allocation.claimId, allocationCommitment: evidence.allocationCommitment
          });
        } catch {
          return { status: "pending" };
        }
        if (claimState !== "unclaimed") return { status: "state_conflict" };
        const released = await releaseUnsubmittedPayrollSettlementAttempt(db, {
          workspaceId: input.workspaceId, runId: input.runId, allocationId: input.allocationId
        });
        return released ? { status: "retry_ready" } : { status: "pending" };
      }
      if (allocation.status !== "unclaimed") {
        throw new PayrollConfidentialSettlementError("payroll_claim_state_conflict", 409);
      }
      await verifyPayrollClaimTransaction({
        signature: evidence.transactionSignature, authorityAddress: evidence.authorityAddress,
        workspaceId: input.workspaceId, allocationCommitment: evidence.allocationCommitment,
        claims: [{ claimId: allocation.claimId, claimAddress: allocation.claimAddress, contributorAddress: input.contributorAddress }]
      });
      const rawReserve = await fetchEncodedAccount(rpc, address(reserveToken));
      let knownAvailable = "0";
      if (rawReserve.exists) {
        const token = (await fetchToken(rpc, address(reserveToken))).data;
        if (confidentialExtension(token)) {
          knownAvailable = (await fetchConfidentialTransferBalance({
            token: address(reserveToken), rpc, elgamalSecretKey: secret, aesKey
          })).availableBalance.toString();
        }
      }
      const attempt = await beginPayrollSettlementAttempt(db, {
        workspaceId: input.workspaceId, runId: input.runId, allocationId: input.allocationId,
        claimAddress: allocation.claimAddress, claimCreationSignature: allocation.transactionSignature,
        sourceAvailableBefore: knownAvailable
      });
      if (attempt.status === "workspace_busy") return { status: "workspace_busy" };
      if (attempt.status === "pending") return { status: "pending", signature: attempt.signature ?? undefined };
      if (attempt.status === "reserve_not_found") {
        throw new PayrollConfidentialSettlementError("workspace_reserve_not_initialized", 409);
      }
      if (attempt.status !== "started") {
        throw new PayrollConfidentialSettlementError("payroll_claim_state_conflict", 409);
      }

      let submittedSignature: string | undefined;
      let proofDurationMs: number | undefined;
      let proofContexts: string[] = [];
      let sequence = createConfidentialSequenceProgress();
      try {
        await ensureReserveConfidentialAccount({
          rpc, signer, mint, mintAccount, tokenAddress: reserveToken, elgamal, aesKey
        });
        const destinationToken = (await fetchToken(rpc, address(destination))).data;
        assertConfidentialAccount(destinationToken, input.contributorAddress, mint, "contributor_confidential_account_not_ready");
        assertConfidentialStepAllowed(sequence, "reserve_configure");
        const configured = await executePlan(rpc, signer, singleInstructionPlan(configureReserveInstruction({
          programId, authority: evidence.authorityAddress, workspace, reserveState,
          reserveAuthority: signer.address, reserveToken, mint
        })));
        if (!configured.successful || configured.pending || configured.trackingFailed) {
          throw new PayrollConfidentialSettlementError("reserve_program_configuration_failed", 503);
        }
        sequence = advanceConfidentialSequence(sequence, "reserve_configure", "finalized");

        let balance = await readReserveBalance(rpc, reserveToken, secret, aesKey);
        if (balance.confidential.pendingBalance > 0n) {
          assertConfidentialStepAllowed(sequence, "pending_apply_before_deposit");
          const apply = await executePlan(rpc, signer, singleInstructionPlan(getApplyConfidentialPendingBalanceInstructionFromToken({
            token: address(reserveToken), tokenAccount: balance.token, authority: signer, elgamalSecretKey: secret, aesKey
          })));
          if (!apply.successful || apply.pending || apply.trackingFailed) {
            throw new PayrollConfidentialSettlementError("reserve_pending_balance_apply_failed", 503);
          }
          assertConfidentialStepAllowed(sequence, "pending_apply_before_deposit");
          sequence = advanceConfidentialSequence(sequence, "pending_apply_before_deposit", "finalized");
          balance = await readReserveBalance(rpc, reserveToken, secret, aesKey);
        }
        const amount = BigInt(allocation.amountBaseUnits);
        const amountCommitmentMaterial = derivePayrollAmountCommitmentMaterial({
          amountBaseUnits: allocation.amountBaseUnits,
          claimId: allocation.claimId,
          secretHex: config.PAYLORE_PAYROLL_AMOUNT_COMMITMENT_SECRET!
        });
        if (allocation.amountCommitment !== amountCommitmentMaterial.amountCommitment) {
          throw new PayrollConfidentialSettlementError("payroll_amount_commitment_mismatch", 409);
        }
        if (balance.confidential.availableBalance < amount) {
          const shortfall = amount - balance.confidential.availableBalance;
          if (balance.token.amount < shortfall) {
            throw new PayrollConfidentialSettlementError("reserve_confidential_balance_insufficient", 409);
          }
          assertConfidentialStepAllowed(sequence, "deposit");
          const deposit = await executePlan(rpc, signer, singleInstructionPlan(getConfidentialDepositInstruction({
            token: address(reserveToken), mint: mintAddress, authority: signer, amount: shortfall, decimals: mintAccount.decimals
          })));
          if (!deposit.successful || deposit.pending || deposit.trackingFailed) {
            throw new PayrollConfidentialSettlementError("reserve_confidential_deposit_failed", 503);
          }
          assertConfidentialStepAllowed(sequence, "deposit");
          sequence = advanceConfidentialSequence(sequence, "deposit", "finalized");
          balance = await readReserveBalance(rpc, reserveToken, secret, aesKey);
          if (balance.confidential.pendingBalance > 0n) {
            assertConfidentialStepAllowed(sequence, "pending_apply_after_deposit");
            const applied = await executePlan(rpc, signer, singleInstructionPlan(getApplyConfidentialPendingBalanceInstructionFromToken({
              token: address(reserveToken), tokenAccount: balance.token, authority: signer, elgamalSecretKey: secret, aesKey
            })));
            if (!applied.successful || applied.pending || applied.trackingFailed) {
              throw new PayrollConfidentialSettlementError("reserve_pending_balance_apply_failed", 503);
            }
            assertConfidentialStepAllowed(sequence, "pending_apply_after_deposit");
            sequence = advanceConfidentialSequence(sequence, "pending_apply_after_deposit", "finalized");
            balance = await readReserveBalance(rpc, reserveToken, secret, aesKey);
          }
        }
        if (balance.confidential.availableBalance < amount) {
          throw new PayrollConfidentialSettlementError("reserve_confidential_balance_insufficient", 409);
        }
        const sourceBefore = balance.confidential.availableBalance.toString();
        if (!await updatePendingPayrollSettlementBalanceSnapshot(db, {
          workspaceId: input.workspaceId, runId: input.runId, allocationId: input.allocationId, sourceAvailableBefore: sourceBefore
        })) throw new PayrollConfidentialSettlementError("payroll_claim_state_conflict", 409);

        const [source, target] = await Promise.all([
          fetchToken(rpc, address(reserveToken)), fetchToken(rpc, address(destination))
        ]);
        const proofStarted = performance.now();
        const unboundTransferPlan = await getConfidentialTransferInstructionPlan({
          sourceToken: address(reserveToken), mint: mintAddress, mintAccount, destinationToken: address(destination),
          sourceTokenAccount: source.data, destinationTokenAccount: target.data, authority: signer,
          amount, sourceElgamalKeypair: elgamal, aesKey, payer: signer, rpc
        });
        const transferPlan = {
          ...unboundTransferPlan,
          plans: unboundTransferPlan.plans.map((plan, index) =>
            index === 0 ? bindAmountCommitmentProof(plan, elgamal, amountCommitmentMaterial) : plan
          )
        } as typeof unboundTransferPlan;
        proofDurationMs = Math.max(0, performance.now() - proofStarted);
        if (transferPlan.kind !== "sequential" || transferPlan.plans.length !== 3 || transferPlan.plans[1]?.kind !== "single") {
          throw new PayrollConfidentialSettlementError("confidential_transfer_plan_invalid", 503);
        }
        const cleanupPlan = transferPlan.plans[2]!;
        proofContexts = getProofContextAddresses(cleanupPlan);
        if (proofContexts.length !== 3 || !await setPayrollSettlementProofContexts(db, {
          workspaceId: input.workspaceId, runId: input.runId, allocationId: input.allocationId, addresses: proofContexts
        })) throw new PayrollConfidentialSettlementError("confidential_proof_contexts_invalid", 503);

        const transferIx = transferPlan.plans[1].instruction;
        const accounts = transferIx.accounts ?? [];
        const amountCommitmentContext = accounts[4]?.address;
        if (typeof amountCommitmentContext !== "string" ||
            transferIx.programAddress !== TOKEN_2022_PROGRAM_ADDRESS || transferIx.data[0] !== 27 ||
            transferIx.data[1] !== 7 || accounts[0]?.address !== reserveToken ||
            accounts[1]?.address !== mint || accounts[2]?.address !== destination) {
          throw new PayrollConfidentialSettlementError("confidential_transfer_instruction_invalid", 503);
        }

        assertConfidentialStepAllowed(sequence, "proof_setup");
        const setup = await executePlan(rpc, signer, transferPlan.plans[0]!, async (sig) => {
          const persisted = await appendPayrollSettlementContextSignature(db, {
            workspaceId: input.workspaceId, runId: input.runId, allocationId: input.allocationId, signature: sig
          });
          if (!persisted) throw new Error("Proof setup signature persistence failed.");
        });
        if (setup.pending) return { status: "pending", signature: setup.signatures.at(-1) };
        if (!setup.successful || setup.trackingFailed) {
          const cleaned = await cleanupProofContexts(db, rpc, signer, {
            workspaceId: input.workspaceId, runId: input.runId, allocationId: input.allocationId, addresses: proofContexts
          });
          if (!cleaned) return { status: "pending", warning: "proof_context_cleanup_pending" };
          await releaseUnsubmittedPayrollSettlementAttempt(db, {
            workspaceId: input.workspaceId, runId: input.runId, allocationId: input.allocationId
          });
          throw new PayrollConfidentialSettlementError("confidential_transfer_proof_setup_failed", 503);
        }

        sequence = advanceConfidentialSequence(sequence, "proof_setup", "finalized");

        const boundPlan = bindAmountBoundClaimedStateToConfidentialTransfer(
          transferPlan,
          markClaimedInstruction({
            programId, contributor: input.contributorAddress, workspace, reserveState,
            reserveAuthority: signer.address, reserveToken, mint, destination, claim: allocation.claimAddress,
            amountCommitmentContext
          }),
          { source: reserveToken, mint, destination }
        );
        if (boundPlan.kind !== "sequential" || boundPlan.plans[1]?.kind !== "sequential") {
          throw new PayrollConfidentialSettlementError("confidential_transfer_plan_invalid", 503);
        }
        const atomic = boundPlan.plans[1];
        let attached = false;
        assertConfidentialStepAllowed(sequence, "confidential_transfer");
        const result = await executePlan(rpc, signer, atomic, async (sig) => {
          submittedSignature = sig;
          try {
            const tracked = await attachPayrollSettlementSignature(db, {
              workspaceId: input.workspaceId, runId: input.runId, allocationId: input.allocationId,
              claimAddress: allocation.claimAddress!, claimCreationSignature: allocation.transactionSignature!,
              settlementSignature: sig, sourceAvailableBefore: sourceBefore
            });
            attached = tracked.status === "attached" || tracked.status === "duplicate";
          } catch {
            // The submitted transaction is reconciled from its chain signature on this attempt.
            attached = false;
          }
          if (!attached) {
            try {
              await appendPayrollSettlementContextSignature(db, {
                workspaceId: input.workspaceId, runId: input.runId, allocationId: input.allocationId, signature: sig
              });
            } catch {
              // Keep the response pending; never report an unrecorded transfer as paid.
            }
          }
        });
        if (result.pending) return { status: "pending", signature: submittedSignature, proofDurationMs, warning: "proof_context_cleanup_pending" };
        if (!submittedSignature || !result.signatures.includes(submittedSignature)) {
          throw new PayrollConfidentialSettlementError("confidential_transfer_submission_failed", 503);
        }
        const reconciled = await reconcileSettlement(db, rpc, signer, secret, aesKey, {
          workspaceId: input.workspaceId, runId: input.runId, allocationId: input.allocationId,
          contributorUserId: input.contributorUserId, contributor: input.contributorAddress,
          claim: allocation.claimAddress, claimId: allocation.claimId, creationSignature: allocation.transactionSignature,
          settlementSignature: submittedSignature, amount: allocation.amountBaseUnits, mint, programId,
          authority: evidence.authorityAddress, commitment: evidence.allocationCommitment, workspace, reserveState,
          reserveToken, destination, sourceBefore, proofContexts, proofDurationMs
        });
        if (reconciled.status === "claimed") {
          assertConfidentialStepAllowed(sequence, "confidential_transfer");
          sequence = advanceConfidentialSequence(sequence, "confidential_transfer", "finalized");
        }
        return reconciled;
      } catch (error) {
        if (!submittedSignature) {
          if (proofContexts.length > 0) {
            const cleaned = await cleanupProofContexts(db, rpc, signer, {
              workspaceId: input.workspaceId, runId: input.runId, allocationId: input.allocationId, addresses: proofContexts
            });
            if (!cleaned) return { status: "pending", warning: "proof_context_cleanup_pending" };
          }
          await releaseUnsubmittedPayrollSettlementAttempt(db, {
            workspaceId: input.workspaceId, runId: input.runId, allocationId: input.allocationId
          });
          if (error instanceof PayrollConfidentialSettlementError) throw error;
          throw new PayrollConfidentialSettlementError("confidential_settlement_failed", 503);
        }
        return {
          status: "pending", signature: submittedSignature,
          ...(proofDurationMs === undefined ? {} : { proofDurationMs }),
          warning: "proof_context_cleanup_pending"
        };
      }
    } finally {
      secret.free(); elgamal.free(); aesKey.free();
      derived.elgamalKeypair.secretKey.fill(0); derived.aeKey.fill(0);
    }
  });
}
