import "server-only";

import { createHash } from "node:crypto";
import {
  AccountRole, address, blockhash, createKeyPairSignerFromBytes, createSolanaRpc,
  createTransactionMessage, createTransactionPlanExecutorWithConcurrentLeaves,
  createTransactionPlanner, fetchEncodedAccount, getAddressEncoder,
  getBase64EncodedWireTransaction, getProgramDerivedAddress, isSome,
  nonDivisibleSequentialInstructionPlan, partiallySignTransactionMessageWithSigners,
  setTransactionMessageFeePayerSigner, setTransactionMessageLifetimeUsingBlockhash,
  singleInstructionPlan, type Instruction, type InstructionPlan, type Signature
} from "@solana/kit";
import {
  fetchMint, fetchToken, findAssociatedTokenPda, TOKEN_2022_PROGRAM_ADDRESS
} from "@solana-program/token-2022";
import {
  deriveConfidentialKeys, fetchConfidentialTransferBalance,
  getApplyConfidentialPendingBalanceInstructionFromToken,
  getConfidentialTransferInstructionPlan
} from "@solana-program/token-2022/confidential";
import { closeContextStateProof, ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS } from "@solana-program/zk-elgamal-proof";
import { AeKey, ElGamalKeypair, ElGamalSecretKey } from "@solana/zk-sdk/bundler";
import {
  appendPayrollClaimEscrowContextSignature, attachPayrollClaimEscrowRecoveryApplySignature,
  attachPayrollClaimEscrowRecoverySignature, beginPayrollRecoveryAttempt,
  clearPayrollClaimEscrowProofContexts, clearPayrollClaimEscrowRecoveryApplySignature,
  getPayrollClaimCreationEvidence, getPayrollClaimEscrow, getWorkspacePayrollRun,
  getWorkspaceReserve, recordPayrollRecovery, releasePayrollRecoveryAttempt,
  resetFailedPayrollRecoveryAttempt, setPayrollClaimEscrowProofContexts,
  setPayrollClaimEscrowRecoveryBalanceSnapshot, type Database
} from "@paylore/database";
import { loadPayloreConfig } from "../config";
import { withWorkspaceReserveKey } from "../reserve";
import {
  getFinalizedPayrollClaimState, verifyPayrollRecoveryTransaction
} from "./payroll-program-verification";
import { bindAmountCommitmentProof, PayrollAmountProofBindingError } from "./payroll-amount-proof-binding";
import { derivePayrollAmountCommitmentMaterial } from "./payroll-amount-commitment";
import { classifyTransactionFinality, getProofContextAddresses } from "./payroll-confidential-settlement-policy";

const DEVNET_RPC_URL = "https://api.devnet.solana.com";
const FINALITY_TIMEOUT_MS = 120_000;
const INSTRUCTIONS_SYSVAR = address("Sysvar1nstructions1111111111111111111111111");
const SYSTEM_PROGRAM = address("11111111111111111111111111111111");
const encoder = new TextEncoder();

type Token = Awaited<ReturnType<typeof fetchToken>>["data"];
type Mint = Awaited<ReturnType<typeof fetchMint>>["data"];
type RecoveryPhase = "proof_setup" | "reserve_balance_apply" | "recovery";

export type PayrollConfidentialRecoveryResult = {
  status: "recovered" | "already_reconciled" | "pending" | "retry_ready" | "workspace_busy";
  signature?: string;
  phase?: RecoveryPhase;
  warning?: "proof_context_cleanup_pending";
};

export class PayrollConfidentialRecoveryError extends Error {
  constructor(readonly code: string, readonly statusCode: number) {
    super(code);
    this.name = "PayrollConfidentialRecoveryError";
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
function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (hex) => Number.parseInt(hex, 16));
}
function extensions(value: Token | Mint): readonly { __kind: string }[] {
  return isSome(value.extensions) ? value.extensions.value : [];
}
function confidentialExtension(token: Token): Record<string, unknown> | null {
  const extension = extensions(token).find((item) => item.__kind === "ConfidentialTransferAccount");
  return extension ? extension as unknown as Record<string, unknown> : null;
}
function assertConfidentialAccount(token: Token, owner: string, mint: string, code: string): void {
  const extension = confidentialExtension(token);
  if (token.owner !== owner || token.mint !== mint || !extension ||
      extension.approved !== true || extension.allowConfidentialCredits !== true) {
    throw new PayrollConfidentialRecoveryError(code, 409);
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
async function waitForFinality(
  rpc: ReturnType<typeof createSolanaRpc>,
  signature: Signature
): Promise<"finalized" | "failed" | "pending"> {
  const deadline = Date.now() + FINALITY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    try {
      const value = (await rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }).send()).value[0];
      const finality = classifyTransactionFinality(value);
      if (finality !== "pending") return finality;
    } catch {
      // A temporary RPC failure is not a transaction failure.
    }
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
        try { await submitted(text); } catch { trackingFailed = true; }
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
async function confidentialBalance(
  rpc: ReturnType<typeof createSolanaRpc>,
  tokenAddress: string,
  secret: ElGamalSecretKey,
  aesKey: AeKey
) {
  const [token, balance] = await Promise.all([
    fetchToken(rpc, address(tokenAddress)),
    fetchConfidentialTransferBalance({
      token: address(tokenAddress), rpc, elgamalSecretKey: secret, aesKey
    })
  ]);
  return { token: token.data, available: balance.availableBalance, pending: balance.pendingBalance };
}
async function deriveWorkspaceReserve(input: { authority: string; workspaceId: string; programId: string }) {
  const workspaceSeed = createHash("sha256").update(`paylore:workspace:v1:${input.workspaceId}`).digest();
  const [workspace] = await getProgramDerivedAddress({
    programAddress: address(input.programId),
    seeds: [encoder.encode("workspace"), getAddressEncoder().encode(address(input.authority)), workspaceSeed]
  });
  const [reserveState] = await getProgramDerivedAddress({
    programAddress: address(input.programId),
    seeds: [encoder.encode("reserve"), getAddressEncoder().encode(workspace)]
  });
  return { workspace, reserveState };
}
function recoveryInstruction(input: {
  programId: string;
  contributor: string;
  workspace: string;
  reserveState: string;
  reserveAuthority: string;
  reserveToken: string;
  mint: string;
  claim: string;
  escrowToken: string;
  amountCommitmentContext: string;
  reasonCommitment: string;
}): Instruction {
  return {
    programAddress: address(input.programId),
    accounts: [
      { address: address(input.contributor), role: AccountRole.READONLY },
      { address: address(input.workspace), role: AccountRole.READONLY },
      { address: address(input.reserveState), role: AccountRole.WRITABLE },
      { address: address(input.reserveAuthority), role: AccountRole.READONLY_SIGNER },
      { address: address(input.reserveToken), role: AccountRole.WRITABLE },
      { address: address(input.mint), role: AccountRole.READONLY },
      { address: address(input.claim), role: AccountRole.WRITABLE },
      { address: address(input.escrowToken), role: AccountRole.WRITABLE },
      { address: INSTRUCTIONS_SYSVAR, role: AccountRole.READONLY },
      { address: address(input.amountCommitmentContext), role: AccountRole.READONLY }
    ],
    data: Uint8Array.from([
      ...discriminator("global:recover_claim"),
      ...hexBytes(input.reasonCommitment)
    ])
  };
}
async function cleanupRecoveryProofContexts(
  db: Database,
  rpc: ReturnType<typeof createSolanaRpc>,
  signer: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>,
  input: { workspaceId: string; allocationId: string; addresses: string[] }
): Promise<boolean> {
  let resolved = true;
  for (const addressText of new Set(input.addresses)) {
    try {
      const account = await fetchEncodedAccount(rpc, address(addressText));
      if (!account.exists) continue;
      if (account.owner !== ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS) { resolved = false; continue; }
      const close = closeContextStateProof({
        contextState: address(addressText),
        authority: signer,
        destination: address(signer.address)
      });
      const result = await executePlan(rpc, signer, singleInstructionPlan(close));
      if (!result.successful || result.pending || result.trackingFailed) resolved = false;
    } catch {
      resolved = false;
    }
  }
  if (!resolved) return false;
  return clearPayrollClaimEscrowProofContexts(db, {
    workspaceId: input.workspaceId, allocationId: input.allocationId, phase: "recovery"
  });
}
function recoveryReasonCommitment(reason: string, note: string | null): string {
  return createHash("sha256")
    .update(`paylore:recovery:v1:${JSON.stringify({ reason, note })}`)
    .digest("hex");
}

export async function recoverPayrollAllocation(
  db: Database,
  input: {
    workspaceId: string;
    runId: string;
    allocationId: string;
    actorUserId: string;
    reason: "incorrect_allocation" | "contributor_left_before_claim" | "payroll_correction" | "other";
    note: string | null;
    signature?: string | null;
    phase?: RecoveryPhase | null;
  }
): Promise<PayrollConfidentialRecoveryResult> {
  if (input.reason === "other" && !input.note?.trim()) {
    throw new PayrollConfidentialRecoveryError("payroll_recovery_reason_required", 400);
  }
  const runResult = await getWorkspacePayrollRun(db, input.workspaceId, input.runId);
  const allocation = runResult?.allocations.find((row) => row.id === input.allocationId);
  if (!runResult || !allocation || !allocation.claimAddress) {
    throw new PayrollConfidentialRecoveryError("payroll_allocation_not_found", 404);
  }
  if (!/^(0|[1-9][0-9]*)$/.test(allocation.amountBaseUnits) ||
      BigInt(allocation.amountBaseUnits) <= 0n ||
      !/^[0-9a-f]{64}$/i.test(allocation.claimId) ||
      !allocation.amountCommitment || !/^[0-9a-f]{64}$/i.test(allocation.amountCommitment)) {
    throw new PayrollConfidentialRecoveryError("payroll_allocation_commitment_invalid", 409);
  }
  if (allocation.status === "claimed" || allocation.status === "recovered" || allocation.status === "cancelled") {
    if (allocation.status === "recovered") return { status: "already_reconciled", signature: allocation.transactionSignature ?? undefined };
    throw new PayrollConfidentialRecoveryError("payroll_allocation_not_recoverable", 409);
  }

  const config = loadPayloreConfig();
  const mint = config.PAYLORE_WRAPPED_USDC_MINT;
  const programId = config.PAYLORE_PAYROLL_PROGRAM_ID;
  if (!mint || !programId || !config.PAYLORE_PAYROLL_AMOUNT_COMMITMENT_SECRET) {
    throw new PayrollConfidentialRecoveryError("payroll_recovery_not_configured", 503);
  }
  const evidence = await getPayrollClaimCreationEvidence(db, {
    workspaceId: input.workspaceId, runId: input.runId, claimId: allocation.claimId, claimAddress: allocation.claimAddress
  });
  if (!evidence || evidence.programId !== programId ||
      evidence.allocationCommitment !== runResult.run.allocationCommitment) {
    throw new PayrollConfidentialRecoveryError("payroll_claim_creation_unverified", 409);
  }
  const reserve = await getWorkspaceReserve(db, input.workspaceId);
  if (!reserve) throw new PayrollConfidentialRecoveryError("workspace_reserve_not_initialized", 409);

  return withWorkspaceReserveKey(db, input.workspaceId, async (privateBytes) => {
    const signer = await createKeyPairSignerFromBytes(privateBytes);
    if (signer.address !== reserve.address) throw new PayrollConfidentialRecoveryError("workspace_reserve_key_mismatch", 503);
    const escrow = await getPayrollClaimEscrow(db, input.workspaceId, input.allocationId);
    if (!escrow || escrow.payrollRunId !== input.runId || escrow.claimId !== allocation.claimId) {
      throw new PayrollConfidentialRecoveryError("payroll_claim_escrow_not_found", 409);
    }
    const rpc = createSolanaRpc(rpcEndpoint());
    const mintAddress = address(mint);
    const mintAccount = (await fetchMint(rpc, mintAddress)).data;
    if (mintAccount.decimals !== 6 ||
        !extensions(mintAccount).some((item) => item.__kind === "ConfidentialTransferMint")) {
      throw new PayrollConfidentialRecoveryError("confidential_mint_unavailable", 503);
    }
    const [reserveTokenAddress] = await findAssociatedTokenPda({
      owner: address(signer.address), mint: mintAddress, tokenProgram: TOKEN_2022_PROGRAM_ADDRESS
    });
    const { workspace, reserveState } = await deriveWorkspaceReserve({
      authority: evidence.authorityAddress, workspaceId: input.workspaceId, programId
    });

    if (escrow.recoverySignature) {
      return reconcileSubmittedRecovery(db, rpc, signer, input, {
        allocation, escrow, evidence, amount: BigInt(allocation.amountBaseUnits), mint,
        programId, reserveTokenAddress, workspace, reserveState, escrowTokenAddress: escrow.tokenAccountAddress
      });
    }

    if (input.signature && input.phase === "reserve_balance_apply") {
      const finality = await waitForFinality(rpc, input.signature as Signature);
      if (finality === "pending") return { status: "pending", signature: input.signature, phase: "reserve_balance_apply" };
      if (finality === "failed") {
        await clearPayrollClaimEscrowRecoveryApplySignature(db, {
          workspaceId: input.workspaceId, allocationId: input.allocationId, signature: input.signature
        });
        return { status: "retry_ready", signature: input.signature };
      }
      await clearPayrollClaimEscrowRecoveryApplySignature(db, {
        workspaceId: input.workspaceId, allocationId: input.allocationId, signature: input.signature
      });
    } else if (input.signature && input.phase === "proof_setup") {
      const finality = await waitForFinality(rpc, input.signature as Signature);
      if (finality === "pending") return { status: "pending", signature: input.signature, phase: "proof_setup" };
      if (!await cleanupRecoveryProofContexts(db, rpc, signer, {
        workspaceId: input.workspaceId, allocationId: input.allocationId,
        addresses: escrow.recoveryProofContextAddresses ?? []
      })) return { status: "pending", signature: input.signature, phase: "proof_setup", warning: "proof_context_cleanup_pending" };
      const released = await releasePayrollRecoveryAttempt(db, {
        workspaceId: input.workspaceId, runId: input.runId, allocationId: input.allocationId
      });
      return released ? { status: "retry_ready", signature: input.signature } : { status: "pending", signature: input.signature, phase: "proof_setup" };
    } else if (input.signature && input.phase === "recovery") {
      return reconcileSubmittedRecovery(db, rpc, signer, input, {
        allocation, escrow, evidence, amount: BigInt(allocation.amountBaseUnits), mint,
        programId, reserveTokenAddress, workspace, reserveState, escrowTokenAddress: escrow.tokenAccountAddress
      }, input.signature);
    }

    if (allocation.status === "unclaimed" && escrow.status === "funded") {
      const attempt = await beginPayrollRecoveryAttempt(db, {
        workspaceId: input.workspaceId, runId: input.runId, allocationId: input.allocationId
      });
      if (attempt.status === "workspace_busy") return { status: "workspace_busy" };
      if (attempt.status === "reserve_not_found") {
        throw new PayrollConfidentialRecoveryError("workspace_reserve_not_initialized", 409);
      }
      if (attempt.status !== "started") {
        throw new PayrollConfidentialRecoveryError("payroll_recovery_state_conflict", 409);
      }
    } else if (allocation.status !== "recovery_pending" || escrow.status !== "recovery_pending") {
      throw new PayrollConfidentialRecoveryError("payroll_recovery_state_conflict", 409);
    }

    const material = derivePayrollAmountCommitmentMaterial({
      amountBaseUnits: allocation.amountBaseUnits,
      claimId: allocation.claimId,
      secretHex: config.PAYLORE_PAYROLL_AMOUNT_COMMITMENT_SECRET
    });
    try {
      if (material.amountCommitment !== allocation.amountCommitment) {
        await releasePayrollRecoveryAttempt(db, {
          workspaceId: input.workspaceId, runId: input.runId, allocationId: input.allocationId
        });
        throw new PayrollConfidentialRecoveryError("payroll_amount_commitment_mismatch", 409);
      }
      const derived = await deriveConfidentialKeys({ signer });
      const secret = ElGamalSecretKey.fromBytes(derived.elgamalKeypair.secretKey);
      const elgamal = ElGamalKeypair.fromSecretKey(secret);
      const aesKey = AeKey.fromBytes(derived.aeKey);
      try {
        const [sourceTokenRaw, reserveTokenRaw] = await Promise.all([
          fetchEncodedAccount(rpc, address(escrow.tokenAccountAddress)),
          fetchEncodedAccount(rpc, reserveTokenAddress)
        ]);
        if (!sourceTokenRaw.exists || !reserveTokenRaw.exists) {
          throw new PayrollConfidentialRecoveryError("payroll_recovery_token_account_missing", 409);
        }
        const [source, destination] = await Promise.all([
          confidentialBalance(rpc, escrow.tokenAccountAddress, secret, aesKey),
          confidentialBalance(rpc, reserveTokenAddress, secret, aesKey)
        ]);
        assertConfidentialAccount(source.token, signer.address, mint, "recovery_escrow_confidential_account_not_ready");
        assertConfidentialAccount(destination.token, signer.address, mint, "reserve_confidential_account_not_ready");
        const amount = BigInt(allocation.amountBaseUnits);
        if (source.pending !== 0n || source.available < amount) {
          throw new PayrollConfidentialRecoveryError("recovery_escrow_available_balance_insufficient", 409);
        }

        if (destination.pending > 0n) {
          const apply = await executePlan(rpc, signer, singleInstructionPlan(
            getApplyConfidentialPendingBalanceInstructionFromToken({
              token: reserveTokenAddress, tokenAccount: destination.token, authority: signer,
              elgamalSecretKey: secret, aesKey
            })
          ), async (signature) => {
            if (!await attachPayrollClaimEscrowRecoveryApplySignature(db, {
              workspaceId: input.workspaceId, allocationId: input.allocationId, signature
            })) throw new Error("The reserve balance reconciliation signature could not be persisted.");
          });
          if (apply.pending) return { status: "pending", signature: apply.signatures.at(-1), phase: "reserve_balance_apply" };
          if (!apply.successful || apply.trackingFailed) {
            const sig = apply.signatures.at(-1);
            if (sig) await clearPayrollClaimEscrowRecoveryApplySignature(db, {
              workspaceId: input.workspaceId, allocationId: input.allocationId, signature: sig
            });
            throw new PayrollConfidentialRecoveryError("reserve_pending_balance_apply_failed", 503);
          }
          const sig = apply.signatures.at(-1);
          if (sig) await clearPayrollClaimEscrowRecoveryApplySignature(db, {
            workspaceId: input.workspaceId, allocationId: input.allocationId, signature: sig
          });
        }
        const refreshedDestination = await confidentialBalance(rpc, reserveTokenAddress, secret, aesKey);
        if (refreshedDestination.pending !== 0n) {
          throw new PayrollConfidentialRecoveryError("reserve_pending_balance_unreconciled", 409);
        }
        const sourceBefore = source.available.toString();
        const reserveBefore = refreshedDestination.available.toString();
        const snapshot = await setPayrollClaimEscrowRecoveryBalanceSnapshot(db, {
          workspaceId: input.workspaceId, allocationId: input.allocationId,
          sourceAvailableBefore: sourceBefore, reserveAvailableBefore: reserveBefore
        });
        if (snapshot.status !== "prepared" && snapshot.status !== "duplicate") {
          throw new PayrollConfidentialRecoveryError("payroll_recovery_state_conflict", 409);
        }

        const proofStartedPlan = await (async () => getConfidentialTransferInstructionPlan({
          sourceToken: address(escrow.tokenAccountAddress), mint: mintAddress, mintAccount,
          destinationToken: reserveTokenAddress, sourceTokenAccount: source.token,
          destinationTokenAccount: refreshedDestination.token, authority: signer, amount,
          sourceElgamalKeypair: elgamal, aesKey, payer: signer, rpc
        }))();
        const transferPlan = {
          ...proofStartedPlan,
          plans: proofStartedPlan.plans.map((plan, index) => {
            if (index !== 0) return plan;
            try { return bindAmountCommitmentProof(plan, elgamal, material); }
            catch (error) {
              if (error instanceof PayrollAmountProofBindingError) {
                throw new PayrollConfidentialRecoveryError(error.code, 503);
              }
              throw error;
            }
          })
        } as typeof proofStartedPlan;
        if (transferPlan.kind !== "sequential" || transferPlan.plans.length !== 3 ||
            transferPlan.plans[1]?.kind !== "single") {
          throw new PayrollConfidentialRecoveryError("confidential_transfer_plan_invalid", 503);
        }
        const cleanupPlan = transferPlan.plans[2]!;
        const proofContexts = getProofContextAddresses(cleanupPlan);
        if (proofContexts.length !== 3 || !await setPayrollClaimEscrowProofContexts(db, {
          workspaceId: input.workspaceId, allocationId: input.allocationId,
          phase: "recovery", addresses: proofContexts
        })) throw new PayrollConfidentialRecoveryError("recovery_proof_contexts_invalid", 503);

        const transferIx = transferPlan.plans[1].instruction;
        const accounts = transferIx.accounts ?? [];
        const amountCommitmentContext = accounts[4]?.address;
        if (typeof amountCommitmentContext !== "string" ||
            transferIx.programAddress !== TOKEN_2022_PROGRAM_ADDRESS ||
            transferIx.data[0] !== 27 || transferIx.data[1] !== 7 ||
            accounts[0]?.address !== escrow.tokenAccountAddress ||
            accounts[1]?.address !== mint ||
            accounts[2]?.address !== reserveTokenAddress) {
          throw new PayrollConfidentialRecoveryError("confidential_recovery_transfer_invalid", 503);
        }

        const setup = await executePlan(rpc, signer, transferPlan.plans[0]!, async (signature) => {
          if (!await appendPayrollClaimEscrowContextSignature(db, {
            workspaceId: input.workspaceId, allocationId: input.allocationId, phase: "recovery", signature
          })) throw new Error("The recovery proof signature could not be persisted.");
        });
        if (setup.pending) {
          return { status: "pending", signature: setup.signatures.at(-1), phase: "proof_setup" };
        }
        if (!setup.successful || setup.trackingFailed) {
          const cleaned = await cleanupRecoveryProofContexts(db, rpc, signer, {
            workspaceId: input.workspaceId, allocationId: input.allocationId, addresses: proofContexts
          });
          if (cleaned) await releasePayrollRecoveryAttempt(db, {
            workspaceId: input.workspaceId, runId: input.runId, allocationId: input.allocationId
          });
          return cleaned
            ? { status: "retry_ready", signature: setup.signatures.at(-1) }
            : { status: "pending", signature: setup.signatures.at(-1), phase: "proof_setup", warning: "proof_context_cleanup_pending" };
        }

        const reasonCommitment = recoveryReasonCommitment(input.reason, input.reason === "other" ? input.note : null);
        const ix = recoveryInstruction({
          programId, contributor: allocation.contributorWalletAddress, workspace, reserveState,
          reserveAuthority: signer.address, reserveToken: reserveTokenAddress, mint,
          claim: allocation.claimAddress, escrowToken: escrow.tokenAccountAddress,
          amountCommitmentContext, reasonCommitment
        });
        const atomic = nonDivisibleSequentialInstructionPlan([transferIx, ix]);
        const result = await executePlan(rpc, signer, atomic, async (signature) => {
          await attachPayrollClaimEscrowRecoverySignature(db, {
            workspaceId: input.workspaceId, allocationId: input.allocationId, signature
          });
        });
        const signature = result.signatures.at(-1);
        if (!signature) {
          throw new PayrollConfidentialRecoveryError("confidential_recovery_submission_failed", 503);
        }
        if (result.pending) return { status: "pending", signature, phase: "recovery" };
        return reconcileSubmittedRecovery(db, rpc, signer, input, {
          allocation, escrow: await getPayrollClaimEscrow(db, input.workspaceId, input.allocationId) ?? escrow,
          evidence, amount, mint, programId, reserveTokenAddress, workspace, reserveState,
          escrowTokenAddress: escrow.tokenAccountAddress
        }, signature);
      } finally {
        secret.free(); elgamal.free(); aesKey.free();
        derived.elgamalKeypair.secretKey.fill(0); derived.aeKey.fill(0);
      }
    } finally {
      material.opening.fill(0);
    }
  });
}

async function reconcileSubmittedRecovery(
  db: Database,
  rpc: ReturnType<typeof createSolanaRpc>,
  signer: Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>,
  input: {
    workspaceId: string; runId: string; allocationId: string; actorUserId: string;
    reason: "incorrect_allocation" | "contributor_left_before_claim" | "payroll_correction" | "other";
    note: string | null; signature?: string | null; phase?: RecoveryPhase | null;
  },
  context: {
    allocation: NonNullable<Awaited<ReturnType<typeof getWorkspacePayrollRun>>>["allocations"][number];
    escrow: NonNullable<Awaited<ReturnType<typeof getPayrollClaimEscrow>>>;
    evidence: NonNullable<Awaited<ReturnType<typeof getPayrollClaimCreationEvidence>>>;
    amount: bigint; mint: string; programId: string; reserveTokenAddress: string;
    workspace: string; reserveState: string; escrowTokenAddress: string;
  },
  providedSignature?: string
): Promise<PayrollConfidentialRecoveryResult> {
  const signature = providedSignature ?? input.signature ?? context.escrow.recoverySignature;
  if (!signature) return { status: "pending" };
  const finality = await waitForFinality(rpc, signature as Signature);
  if (finality === "pending") return { status: "pending", signature, phase: "recovery" };

  const sourceBefore = context.escrow.recoverySourceAvailableBefore;
  const reserveBefore = context.escrow.recoveryDestinationAvailableBefore;
  if (sourceBefore === null || reserveBefore === null) {
    throw new PayrollConfidentialRecoveryError("payroll_recovery_balance_snapshot_missing", 409);
  }
  const cfg = loadPayloreConfig();
  const derived = await deriveConfidentialKeys({ signer });
  const secret = ElGamalSecretKey.fromBytes(derived.elgamalKeypair.secretKey);
  const aesKey = AeKey.fromBytes(derived.aeKey);
  try {
    if (finality === "failed") {
      const [source, destination, claimState] = await Promise.all([
        confidentialBalance(rpc, context.escrowTokenAddress, secret, aesKey),
        confidentialBalance(rpc, context.reserveTokenAddress, secret, aesKey),
        getFinalizedPayrollClaimState({
          authorityAddress: context.evidence.authorityAddress, workspaceId: input.workspaceId,
          contributorAddress: context.allocation.contributorWalletAddress, claimId: context.allocation.claimId,
          claimAddress: context.allocation.claimAddress!, allocationCommitment: context.evidence.allocationCommitment,
          amountCommitment: context.allocation.amountCommitment!, escrowTokenAccount: context.escrowTokenAddress
        })
      ]);
      if (claimState !== "unclaimed" || source.available.toString() !== sourceBefore ||
          destination.available.toString() !== reserveBefore || destination.pending !== 0n) {
        return { status: "pending", signature, phase: "recovery" };
      }
      await attachPayrollClaimEscrowRecoverySignature(db, {
        workspaceId: input.workspaceId, allocationId: input.allocationId, signature
      });
      const cleaned = await cleanupRecoveryProofContexts(db, rpc, signer, {
        workspaceId: input.workspaceId, allocationId: input.allocationId,
        addresses: context.escrow.recoveryProofContextAddresses ?? []
      });
      const reset = await resetFailedPayrollRecoveryAttempt(db, {
        workspaceId: input.workspaceId, runId: input.runId, allocationId: input.allocationId,
        signature, sourceAvailableAfter: source.available.toString(),
        reserveAvailableAfter: destination.available.toString()
      });
      if (reset && cleaned) return { status: "retry_ready", signature };
      return { status: "pending", signature, phase: "recovery", warning: "proof_context_cleanup_pending" };
    }

    await verifyPayrollRecoveryTransaction({
      signature,
      authorityAddress: context.evidence.authorityAddress,
      reserveAuthorityAddress: signer.address,
      workspaceId: input.workspaceId,
      contributorAddress: context.allocation.contributorWalletAddress,
      claimId: context.allocation.claimId,
      claimAddress: context.allocation.claimAddress!,
      allocationCommitment: context.evidence.allocationCommitment,
      amountCommitment: context.allocation.amountCommitment!,
      escrowTokenAccount: context.escrowTokenAddress,
      reserveTokenAccount: context.reserveTokenAddress,
      mint: context.mint,
      recoveryReasonCommitment: recoveryReasonCommitment(input.reason, input.reason === "other" ? input.note : null)
    });
    if (!await attachPayrollClaimEscrowRecoverySignature(db, {
      workspaceId: input.workspaceId, allocationId: input.allocationId, signature
    })) return { status: "pending", signature, phase: "recovery" };

    let escrow = await getPayrollClaimEscrow(db, input.workspaceId, input.allocationId);
    if (!escrow) throw new PayrollConfidentialRecoveryError("payroll_claim_escrow_not_found", 409);
    if (escrow.recoveryApplySignature) {
      const applyFinality = await waitForFinality(rpc, escrow.recoveryApplySignature as Signature);
      if (applyFinality === "pending") {
        return { status: "pending", signature: escrow.recoveryApplySignature, phase: "reserve_balance_apply" };
      }
      if (applyFinality === "failed") {
        await clearPayrollClaimEscrowRecoveryApplySignature(db, {
          workspaceId: input.workspaceId, allocationId: input.allocationId, signature: escrow.recoveryApplySignature
        });
      } else {
        await clearPayrollClaimEscrowRecoveryApplySignature(db, {
          workspaceId: input.workspaceId, allocationId: input.allocationId, signature: escrow.recoveryApplySignature
        });
      }
    }

    let source = await confidentialBalance(rpc, context.escrowTokenAddress, secret, aesKey);
    let destination = await confidentialBalance(rpc, context.reserveTokenAddress, secret, aesKey);
    if (source.available < 0n || BigInt(sourceBefore) - source.available !== context.amount) {
      return { status: "pending", signature, phase: "recovery" };
    }
    if (destination.pending > 0n) {
      const apply = await executePlan(rpc, signer, singleInstructionPlan(
        getApplyConfidentialPendingBalanceInstructionFromToken({
          token: address(context.reserveTokenAddress), tokenAccount: destination.token,
          authority: signer, elgamalSecretKey: secret, aesKey
        })
      ), async (applySignature) => {
        if (!await attachPayrollClaimEscrowRecoveryApplySignature(db, {
          workspaceId: input.workspaceId, allocationId: input.allocationId, signature: applySignature
        })) throw new Error("The reserve pending-balance signature could not be persisted.");
      });
      const applySignature = apply.signatures.at(-1);
      if (apply.pending) return { status: "pending", signature: applySignature, phase: "reserve_balance_apply" };
      if (!apply.successful || apply.trackingFailed) {
        if (applySignature) await clearPayrollClaimEscrowRecoveryApplySignature(db, {
          workspaceId: input.workspaceId, allocationId: input.allocationId, signature: applySignature
        });
        return { status: "pending", signature, phase: "recovery" };
      }
      if (applySignature) await clearPayrollClaimEscrowRecoveryApplySignature(db, {
        workspaceId: input.workspaceId, allocationId: input.allocationId, signature: applySignature
      });
      [source, destination] = await Promise.all([
        confidentialBalance(rpc, context.escrowTokenAddress, secret, aesKey),
        confidentialBalance(rpc, context.reserveTokenAddress, secret, aesKey)
      ]);
    }
    if (source.available.toString() !== (BigInt(sourceBefore) - context.amount).toString() ||
        destination.available.toString() !== (BigInt(reserveBefore) + context.amount).toString() ||
        destination.pending !== 0n) {
      return { status: "pending", signature, phase: "recovery" };
    }
    const cleanupOk = await cleanupRecoveryProofContexts(db, rpc, signer, {
      workspaceId: input.workspaceId, allocationId: input.allocationId,
      addresses: escrow.recoveryProofContextAddresses ?? []
    });
    const recorded = await recordPayrollRecovery(db, {
      workspaceId: input.workspaceId, runId: input.runId, allocationId: input.allocationId,
      actorUserId: input.actorUserId, reason: input.reason, reasonNote: input.reason === "other" ? input.note : null,
      signature, claimAddress: context.allocation.claimAddress!, sourceAvailableBefore: sourceBefore,
      sourceAvailableAfter: source.available.toString(), reserveAvailableBefore: reserveBefore,
      reserveAvailableAfter: destination.available.toString()
    });
    if (recorded.status === "conflict" || recorded.status === "balance_mismatch") {
      return { status: "pending", signature, phase: "recovery" };
    }
    if (recorded.status === "not_found" || recorded.status === "escrow_not_found") {
      throw new PayrollConfidentialRecoveryError("payroll_recovery_reconciliation_conflict", 409);
    }
    return {
      status: recorded.status === "duplicate" ? "already_reconciled" : "recovered",
      signature,
      ...(!cleanupOk ? { warning: "proof_context_cleanup_pending" as const } : {})
    };
  } finally {
    secret.free(); aesKey.free();
    derived.elgamalKeypair.secretKey.fill(0); derived.aeKey.fill(0);
  }
}
