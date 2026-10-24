import "server-only";

import {
  address,
  blockhash,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  createTransactionPlanExecutorWithConcurrentLeaves,
  createTransactionPlanner,
  fetchEncodedAccount,
  getBase64EncodedWireTransaction,
  partiallySignTransactionMessageWithSigners,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  nonDivisibleSequentialInstructionPlan,
  type InstructionPlan,
  type Signature
} from "@solana/kit";
import { getCreateAccountInstruction } from "@solana-program/system";
import {
  extension,
  fetchMint,
  fetchToken,
  getInitializeAccountInstruction,
  getInitializeImmutableOwnerInstruction,
  getTokenSize,
  TOKEN_2022_PROGRAM_ADDRESS
} from "@solana-program/token-2022";
import {
  deriveConfidentialKeys,
  getCreateConfidentialTransferAccountInstructionPlan
} from "@solana-program/token-2022/confidential";
import { AeKey, ElGamalKeypair, ElGamalSecretKey } from "@solana/zk-sdk/bundler";
import {
  appendPayrollClaimEscrowConfidentialSetupSignature,
  attachPayrollClaimEscrowAccountSetupSignature,
  createPayrollClaimEscrow,
  getPayrollClaimEscrow,
  getWorkspacePayrollRun,
  markPayrollClaimEscrowReady,
  resetFailedPayrollClaimEscrowAccountSetup,
  type Database
} from "@paylore/database";
import { loadPayloreConfig } from "../config";
import { withWorkspaceReserveKey } from "../reserve";
import {
  generateReserveKeypair,
  openReserveKey,
  sealReserveKey
} from "../reserve-crypto-policy";

const DEVNET_RPC_URL = "https://api.devnet.solana.com";
const FINALITY_TIMEOUT_MS = 120_000;

type Finality = "finalized" | "failed" | "pending";
type Signer = Awaited<ReturnType<typeof createKeyPairSignerFromBytes>>;

export class PayrollClaimEscrowError extends Error {
  constructor(readonly code: string, readonly statusCode: number) {
    super(code);
    this.name = "PayrollClaimEscrowError";
  }
}

class FinalityPendingError extends Error {
  constructor(readonly signature: string) {
    super("The escrow account setup is awaiting finality.");
  }
}

class FinalityFailedError extends Error {
  constructor(readonly signature: string) {
    super("The escrow account setup failed at finality.");
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

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function extensionList(value: { extensions?: readonly { __kind: string }[] }): readonly { __kind: string }[] {
  return Array.isArray(value.extensions) ? value.extensions : [];
}

function isConfidentialReady(token: {
  owner: string;
  mint: string;
  extensions?: readonly { __kind: string; [key: string]: unknown }[];
}, expectedOwner: string, expectedMint: string): boolean {
  const ext = extensionList(token).find((item) => item.__kind === "ConfidentialTransferAccount") as
    | ({ __kind: string; approved?: unknown; allowConfidentialCredits?: unknown })
    | undefined;
  return token.owner === expectedOwner &&
    token.mint === expectedMint &&
    extensionList(token).some((item) => item.__kind === "ImmutableOwner") &&
    ext?.approved === true &&
    ext.allowConfidentialCredits === true;
}

function transactionFinality(
  status: { err?: unknown; confirmationStatus?: string | null } | null | undefined
): Finality {
  if (!status || status.confirmationStatus !== "finalized") return "pending";
  return status.err === null || status.err === undefined ? "finalized" : "failed";
}

async function checkSignatureFinality(
  rpc: ReturnType<typeof createSolanaRpc>,
  signatures: string[]
): Promise<Finality> {
  if (signatures.length === 0) return "finalized";
  try {
    for (const signature of signatures) {
      const status = (await rpc.getSignatureStatuses(
        [signature as Signature],
        { searchTransactionHistory: true }
      ).send()).value[0];
      const finality = transactionFinality(status);
      if (finality !== "finalized") return finality;
    }
    return "finalized";
  } catch {
    return "pending";
  }
}

async function waitForFinality(
  rpc: ReturnType<typeof createSolanaRpc>,
  signature: Signature
): Promise<Finality> {
  const deadline = Date.now() + FINALITY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await checkSignatureFinality(rpc, [String(signature)]);
    if (result !== "pending") return result;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  return "pending";
}

async function executePlan(
  rpc: ReturnType<typeof createSolanaRpc>,
  feePayer: Signer,
  plan: InstructionPlan,
  onSubmitted?: (signature: string) => Promise<void>
): Promise<{ status: Finality; signatures: string[]; trackingFailed: boolean }> {
  const planner = createTransactionPlanner({
    createTransactionMessage: () =>
      setTransactionMessageFeePayerSigner(
        feePayer,
        createTransactionMessage({ version: 0 })
      ),
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
      const signature = await rpc.sendTransaction(encoded, {
        encoding: "base64",
        preflightCommitment: "confirmed",
        maxRetries: 3
      }).send();
      const signatureText = String(signature);
      signatures.push(signatureText);
      if (onSubmitted) {
        try {
          await onSubmitted(signatureText);
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
    return { status: trackingFailed ? "pending" : "finalized", signatures, trackingFailed };
  } catch (error) {
    if (error instanceof FinalityPendingError) {
      return { status: "pending", signatures, trackingFailed };
    }
    if (error instanceof FinalityFailedError) {
      return { status: "failed", signatures, trackingFailed };
    }
    throw error;
  }
}

function escrowEnvelopeContext(workspaceId: string, allocationId: string): string {
  return `paylore:claim-escrow:v1:${workspaceId}:${allocationId}`;
}

/** Creates one reserve-owned confidential token account per allocation before its Claim PDA can be committed. */
export async function preparePayrollClaimEscrowAccount(
  db: Database,
  input: {
    workspaceId: string;
    runId: string;
    allocationId: string;
    authorityAddress: string;
    programId: string;
    mintAddress: string;
  }
): Promise<{ status: "ready" | "pending"; tokenAccountAddress: string }> {
  const payroll = await getWorkspacePayrollRun(db, input.workspaceId, input.runId);
  const allocation = payroll?.allocations.find((candidate) => candidate.id === input.allocationId);
  if (!payroll || !allocation || !allocation.claimId ||
      !/^[0-9a-f]{64}$/i.test(allocation.claimId) ||
      allocation.status !== "draft" && allocation.status !== "unclaimed") {
    throw new PayrollClaimEscrowError("payroll_claim_escrow_allocation_invalid", 409);
  }
  if (!/^(0|[1-9][0-9]*)$/.test(allocation.amountBaseUnits) || BigInt(allocation.amountBaseUnits) <= 0n) {
    throw new PayrollClaimEscrowError("payroll_claim_escrow_amount_invalid", 409);
  }
  const config = loadPayloreConfig();
  const envelopeKey = config.PAYLORE_RESERVE_ENVELOPE_KEY;
  if (!envelopeKey) throw new PayrollClaimEscrowError("reserve_envelope_key_not_configured", 503);
  if (config.PAYLORE_NETWORK !== "devnet") {
    throw new PayrollClaimEscrowError("payroll_claim_escrow_devnet_only", 503);
  }
  if (config.PAYLORE_PAYROLL_PROGRAM_ID !== input.programId) {
    throw new PayrollClaimEscrowError("payroll_program_identity_mismatch", 409);
  }
  address(input.authorityAddress);

  const escrowContext = escrowEnvelopeContext(input.workspaceId, input.allocationId);
  let escrow = await getPayrollClaimEscrow(db, input.workspaceId, input.allocationId);
  if (escrow && (escrow.payrollRunId !== input.runId || escrow.claimId !== allocation.claimId)) {
    throw new PayrollClaimEscrowError("payroll_claim_escrow_identity_conflict", 409);
  }
  if (!escrow) {
    const keypair = generateReserveKeypair();
    try {
      const sealed = sealReserveKey(
        escrowContext,
        keypair.address,
        keypair.privateKey,
        envelopeKey
      );
      const created = await createPayrollClaimEscrow(db, {
        workspaceId: input.workspaceId,
        payrollRunId: input.runId,
        allocationId: input.allocationId,
        claimId: allocation.claimId,
        tokenAccountAddress: keypair.address,
        ...sealed
      });
      if (created.status === "allocation_ineligible" || created.status === "conflict") {
        throw new PayrollClaimEscrowError("payroll_claim_escrow_identity_conflict", 409);
      }
      escrow = created.escrow ?? await getPayrollClaimEscrow(db, input.workspaceId, input.allocationId);
    } finally {
      keypair.privateKey.fill(0);
    }
  }
  if (!escrow) throw new PayrollClaimEscrowError("payroll_claim_escrow_not_persisted", 503);
  if (["ready", "funding", "funded", "settlement_pending", "recovery_pending", "claimed", "recovered"].includes(escrow.status)) {
    return { status: "ready", tokenAccountAddress: escrow.tokenAccountAddress };
  }
  if (!escrow.encryptedPrivateKey || !escrow.privateKeyNonce || !escrow.privateKeyAuthTag ||
      !escrow.encryptedDataKey || !escrow.dataKeyNonce || !escrow.dataKeyAuthTag) {
    throw new PayrollClaimEscrowError("payroll_claim_escrow_key_unavailable", 503);
  }

  const tempPrivateKey = openReserveKey(escrowContext, escrow, envelopeKey);
  try {
    return await withWorkspaceReserveKey(db, input.workspaceId, async (reservePrivateKey) => {
      const reserveSigner = await createKeyPairSignerFromBytes(reservePrivateKey);
      const escrowSigner = await createKeyPairSignerFromBytes(tempPrivateKey);
      if (escrowSigner.address !== escrow.tokenAccountAddress) {
        throw new PayrollClaimEscrowError("payroll_claim_escrow_key_mismatch", 503);
      }
      const rpc = createSolanaRpc(rpcEndpoint());
      const mintAddress = address(input.mintAddress);
      const mint = (await fetchMint(rpc, mintAddress)).data;
      if (mint.decimals !== 6) {
        throw new PayrollClaimEscrowError("payroll_claim_escrow_mint_invalid", 409);
      }
      const confidentialMint = extensionList(mint).find((item) => item.__kind === "ConfidentialTransferMint") as
        | { autoApproveNewAccounts?: boolean }
        | undefined;
      if (!confidentialMint || confidentialMint.autoApproveNewAccounts !== true) {
        throw new PayrollClaimEscrowError("payroll_claim_escrow_mint_not_approved", 409);
      }
      const tokenAddress = address(escrow.tokenAccountAddress);
      const existingAccount = await fetchEncodedAccount(rpc, tokenAddress);
      if (!existingAccount.exists) {
        const extensions = [
          extension("ImmutableOwner", {}),
          extension("ConfidentialTransferAccount", {})
        ];
        const space = BigInt(getTokenSize(extensions));
        const rent = await rpc.getMinimumBalanceForRentExemption(space).send();
        const creationPlan = nonDivisibleSequentialInstructionPlan([
          getCreateAccountInstruction({
            payer: reserveSigner,
            newAccount: escrowSigner,
            lamports: rent,
            space,
            programAddress: TOKEN_2022_PROGRAM_ADDRESS
          }),
          getInitializeImmutableOwnerInstruction({ account: tokenAddress }),
          getInitializeAccountInstruction({
            account: tokenAddress,
            mint: mintAddress,
            owner: address(reserveSigner.address)
          })
        ]);
        const creation = await executePlan(rpc, reserveSigner, creationPlan, async (signature) => {
          const persisted = await attachPayrollClaimEscrowAccountSetupSignature(db, {
            workspaceId: input.workspaceId,
            allocationId: input.allocationId,
            signature
          });
          if (!persisted) throw new Error("Escrow account setup signature could not be persisted.");
        });
        if (creation.status === "pending" || creation.trackingFailed) {
          return { status: "pending" as const, tokenAccountAddress: escrow.tokenAccountAddress };
        }
        if (creation.status === "failed") {
          const signature = creation.signatures[0];
          const onChain = await fetchEncodedAccount(rpc, tokenAddress);
          if (signature && !onChain.exists) {
            await resetFailedPayrollClaimEscrowAccountSetup(db, {
              workspaceId: input.workspaceId,
              allocationId: input.allocationId,
              signature
            });
          }
          throw new PayrollClaimEscrowError("payroll_claim_escrow_account_setup_failed", 503);
        }
      } else if (existingAccount.owner !== TOKEN_2022_PROGRAM_ADDRESS) {
        throw new PayrollClaimEscrowError("payroll_claim_escrow_account_owner_invalid", 409);
      }

      const token = (await fetchToken(rpc, tokenAddress)).data;
      if (token.owner !== reserveSigner.address || token.mint !== mintAddress) {
        throw new PayrollClaimEscrowError("payroll_claim_escrow_account_identity_invalid", 409);
      }
      if (!isConfidentialReady(token, reserveSigner.address, mintAddress)) {
        const derived = await deriveConfidentialKeys({ signer: reserveSigner });
        const secret = ElGamalSecretKey.fromBytes(derived.elgamalKeypair.secretKey);
        const elgamal = ElGamalKeypair.fromSecretKey(secret);
        const aesKey = AeKey.fromBytes(derived.aeKey);
        try {
          const setupPlan = await getCreateConfidentialTransferAccountInstructionPlan({
            payer: reserveSigner,
            owner: reserveSigner,
            mint: mintAddress,
            token: tokenAddress,
            rpc,
            elgamalKeypair: elgamal,
            aesKey,
            includeConfidentialTransferFeeAmount: extensionList(mint).some((item) => item.__kind === "TransferFeeConfig")
          });
          const setup = await executePlan(rpc, reserveSigner, setupPlan, async (signature) => {
            const persisted = await appendPayrollClaimEscrowConfidentialSetupSignature(db, {
              workspaceId: input.workspaceId,
              allocationId: input.allocationId,
              signature
            });
            if (!persisted) throw new Error("Escrow confidential setup signature could not be persisted.");
          });
          if (setup.status === "pending" || setup.trackingFailed) {
            return { status: "pending" as const, tokenAccountAddress: escrow.tokenAccountAddress };
          }
          if (setup.status === "failed") {
            throw new PayrollClaimEscrowError("payroll_claim_escrow_confidential_setup_failed", 503);
          }
        } finally {
          secret.free();
          elgamal.free();
          aesKey.free();
          derived.elgamalKeypair.secretKey.fill(0);
          derived.aeKey.fill(0);
        }
      }

      const finalToken = (await fetchToken(rpc, tokenAddress)).data;
      if (!isConfidentialReady(finalToken, reserveSigner.address, mintAddress)) {
        return { status: "pending" as const, tokenAccountAddress: escrow.tokenAccountAddress };
      }
      const ready = await markPayrollClaimEscrowReady(db, {
        workspaceId: input.workspaceId,
        allocationId: input.allocationId,
        tokenAccountAddress: escrow.tokenAccountAddress
      });
      if (ready.status !== "ready" && !["funding", "funded", "settlement_pending", "claimed", "recovered"].includes(ready.status)) {
        throw new PayrollClaimEscrowError("payroll_claim_escrow_state_conflict", 409);
      }
      return { status: "ready" as const, tokenAccountAddress: escrow.tokenAccountAddress };
    });
  } finally {
    tempPrivateKey.fill(0);
  }
}
