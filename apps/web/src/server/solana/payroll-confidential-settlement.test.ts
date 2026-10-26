import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));

import { settleContributorPayrollAllocation } from "./payroll-confidential-settlement";

const h = vi.hoisted(() => ({
  tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  zkProofProgram: "ZkEgalProof111111111111111111111111111111",
  reserveAuthority: "ReserveAuthority1111111111111111111111111",
  contributor: "ContributorWallet11111111111111111111111",
  destination: "ContributorTokenAccount11111111111111111",
  reserveToken: "ReserveTokenAccount111111111111111111111",
  escrowToken: "ClaimEscrowTokenAccount111111111111111111",
  mint: "WrappedUsdcMint11111111111111111111111111",
  programId: "PayloreProgram11111111111111111111111111",
  workspace: "WorkspacePda111111111111111111111111111",
  reserveState: "ReserveState111111111111111111111111111",
  claim: "ClaimPda11111111111111111111111111111111",
  context1: "FundingProofContext111111111111111111111",
  context2: "FundingProofContext222222222222222222222",
  context3: "FundingProofContext333333333333333333333",
  context4: "PayoutProofContext11111111111111111111111",
  context5: "PayoutProofContext22222222222222222222222",
  context6: "PayoutProofContext33333333333333333333333",
  claimId: "11".repeat(32),
  allocationCommitment: "22".repeat(32),
  amountCommitment: "33".repeat(32),
  amountBaseUnits: "1250000",
  allocation: null as any,
  payroll: null as any,
  escrowStatus: "ready",
  fundingSignature: null as string | null,
  fundingSourceAvailableBefore: null as string | null,
  fundingSourceAvailableAfter: null as string | null,
  fundingDestinationAvailableBefore: null as string | null,
  fundingDestinationAvailableAfter: null as string | null,
  payoutSourceAvailableBefore: null as string | null,
  nextSteps: [] as string[],
  executionOrder: [] as string[],
  currentStep: "other",
  currentPlanMode: "other",
  currentPlanContexts: [] as string[],
  sendCount: 0,
  signatureSteps: {} as Record<string, string>,
  pendingSignatures: new Set<string>(),
  pendingSteps: new Set<string>(),
  contextAccounts: new Set<string>(),
  closingContext: "",
  forceDebitOnFailedTransfer: false,
  forceDebitMismatch: false,
  failStep: null as string | null,
  balanceMode: "enough",
  reserveAccountExists: true,
  reserveAvailable: 2_000_000n,
  reservePending: 0n,
  reservePublicAmount: 5_000_000n,
  escrowAvailable: 0n,
  escrowPending: 0n,
  escrowFunded: false,
  claimState: 0,
  settlementSubmitted: false,
  ledgerCalls: 0,
  attachCalls: 0,
  clearContextsCalls: 0,
  releaseCalls: 0,
  releasedFailedCalls: 0,
  beginFundingCalls: 0,
  prepareFundingCalls: 0,
  recordFundingCalls: 0
}));

const SYSVAR_INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111";

function hash(value: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(value).digest());
}
function addressBytes(value: string): Uint8Array { return hash(value); }
function anchorDiscriminator(value: string): Uint8Array { return hash(value).slice(0, 8); }
function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (part) => Number.parseInt(part, 16));
}
function encodeBase58(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    encoded = alphabet[Number(value % 58n)] + encoded;
    value /= 58n;
  }
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes++;
  return "1".repeat(leadingZeroes) + encoded;
}
function claimAccountData(): string {
  const data = new Uint8Array(203);
  data.set(anchorDiscriminator("account:ClaimState"), 0);
  data.set(addressBytes(h.workspace), 8);
  data.set(addressBytes(h.contributor), 40);
  data.set(hexBytes(h.claimId), 72);
  data.set(hexBytes(h.allocationCommitment), 104);
  data.set(hexBytes(h.amountCommitment), 136);
  data.set(addressBytes(h.escrowToken), 168);
  data[200] = h.escrowFunded ? 1 : 0;
  data[201] = h.claimState;
  data[202] = 255;
  return Buffer.from(data).toString("base64");
}
function stepFor(signature: string): string { return h.signatureSteps[signature] ?? "other"; }
function finalizedTransaction(signature: string) {
  const step = stepFor(signature);
  let instructions: Array<Record<string, unknown>>;
  if (step === "escrow_funding") {
    instructions = [
      {
        programId: h.tokenProgram,
        accounts: [h.reserveToken, h.mint, h.escrowToken, h.reserveAuthority, h.context1],
        data: encodeBase58(new Uint8Array([27, 7]))
      },
      {
        programId: h.programId,
        accounts: [h.contributor, h.workspace, h.reserveState, h.reserveAuthority, h.reserveToken,
          h.mint, h.claim, h.escrowToken, SYSVAR_INSTRUCTIONS, h.context1],
        data: encodeBase58(anchorDiscriminator("global:mark_claim_escrow_funded"))
      }
    ];
  } else if (step === "transfer") {
    instructions = [
      {
        programId: h.tokenProgram,
        accounts: [h.escrowToken, h.mint, h.destination, h.reserveAuthority, h.context4],
        data: encodeBase58(new Uint8Array([27, 7]))
      },
      {
        programId: h.programId,
        accounts: [h.contributor, h.workspace, h.reserveState, h.reserveAuthority, h.reserveToken,
          h.mint, h.claim, h.escrowToken, h.destination, SYSVAR_INSTRUCTIONS, h.context4],
        data: encodeBase58(anchorDiscriminator("global:mark_settlement_pending"))
      }
    ];
  } else if (step === "finalize_claimed") {
    instructions = [{
      programId: h.programId,
      accounts: [h.contributor, h.workspace, h.reserveState, h.reserveAuthority, h.claim, SYSVAR_INSTRUCTIONS],
      data: encodeBase58(anchorDiscriminator("global:finalize_claimed"))
    }];
  } else if (step === "configure") {
    instructions = [{
      programId: h.programId,
      accounts: [h.contributor, h.workspace, h.reserveState, h.reserveAuthority, h.reserveToken, h.mint],
      data: encodeBase58(anchorDiscriminator("global:configure_workspace_reserve"))
    }];
  } else if (step.includes("proof_setup")) {
    const context = h.currentPlanContexts[0] ?? h.context1;
    instructions = [{
      programId: h.zkProofProgram, accounts: [context], data: encodeBase58(new Uint8Array([3]))
    }];
  } else if (step.endsWith("context_close")) {
    instructions = [{
      programId: h.zkProofProgram, accounts: [h.closingContext], data: encodeBase58(new Uint8Array([4]))
    }];
  } else {
    instructions = [{
      programId: h.tokenProgram,
      accounts: [h.currentStep === "apply_escrow" ? h.escrowToken : h.reserveToken],
      data: encodeBase58(new Uint8Array([201]))
    }];
  }
  const failed = h.failStep === step;
  return {
    slot: 42,
    meta: { err: failed ? { InstructionError: [0, "Custom"] } : null },
    transaction: {
      signatures: [signature],
      message: { accountKeys: [h.reserveAuthority], instructions }
    }
  };
}
function identifyTransactionStep(plan: unknown): string {
  const instructions: Array<Record<string, unknown>> = [];
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    const node = value as Record<string, unknown>;
    const instruction = node.instruction;
    if (instruction !== null && typeof instruction === "object" && !Array.isArray(instruction)) {
      instructions.push(instruction as Record<string, unknown>);
    } else if (typeof node.programAddress === "string" && node.data instanceof Uint8Array) {
      instructions.push(node);
    }
    if (Array.isArray(node.plans)) node.plans.forEach(visit);
  };
  visit(plan);
  const has = (program: string, first: number, second?: number) => instructions.some((instruction) => {
    const data = instruction.data;
    return instruction.programAddress === program && data instanceof Uint8Array &&
      data[0] === first && (second === undefined || data[1] === second);
  });
  const programInstruction = (name: string) => instructions.some((instruction) =>
    instruction.programAddress === h.programId && instruction.data instanceof Uint8Array &&
    Buffer.from(instruction.data).equals(anchorDiscriminator(name))
  );
  if (programInstruction("global:mark_claim_escrow_funded")) return "escrow_funding";
  if (programInstruction("global:mark_settlement_pending")) return "transfer";
  if (programInstruction("global:finalize_claimed")) return "finalize_claimed";
  if (has(h.tokenProgram, 27, 7)) {
    const transfer = instructions.find((instruction) => instruction.programAddress === h.tokenProgram &&
      instruction.data instanceof Uint8Array && instruction.data[0] === 27 && instruction.data[1] === 7);
    const account = (transfer?.accounts as Array<{ address?: string }> | undefined)?.[2]?.address;
    return account === h.escrowToken ? "escrow_funding" : "transfer";
  }
  if (has(h.tokenProgram, 202)) return "deposit";
  if (has(h.tokenProgram, 204)) return "apply_escrow";
  if (has(h.tokenProgram, 201)) return "apply";
  if (has(h.tokenProgram, 200)) return "account_setup";
  if (has(h.zkProofProgram, 4)) {
    return h.closingContext.startsWith("Payout") ? "payout_context_close" : "funding_context_close";
  }
  if (has(h.zkProofProgram, 3)) {
    return h.currentPlanMode === "funding" ? "funding_proof_setup" : "payout_proof_setup";
  }
  if (programInstruction("global:configure_workspace_reserve")) return "configure";
  return "other";
}
function confidentialExtension(): { __kind: string; approved: boolean; allowConfidentialCredits: boolean } {
  return { __kind: "ConfidentialTransferAccount", approved: true, allowConfidentialCredits: true };
}
function resetHarness(): void {
  Object.assign(h, {
    allocation: {
      id: "allocation-01",
      contributorId: "contributor-01",
      contributorWalletAddress: h.contributor,
      amountBaseUnits: h.amountBaseUnits,
      claimId: h.claimId,
      claimAddress: h.claim,
      transactionSignature: "claim-creation-signature",
      amountCommitment: h.amountCommitment,
      status: "unclaimed",
      settlementSignature: null,
      settlementProofContextAddresses: [],
      settlementContextSignatures: [],
      settlementSourceAvailableBefore: null
    },
    escrowStatus: "ready",
    fundingSignature: null,
    fundingSourceAvailableBefore: null,
    fundingSourceAvailableAfter: null,
    fundingDestinationAvailableBefore: null,
    fundingDestinationAvailableAfter: null,
    payoutSourceAvailableBefore: null,
    nextSteps: [],
    executionOrder: [],
    currentStep: "other",
    currentPlanMode: "other",
    currentPlanContexts: [],
    sendCount: 0,
    signatureSteps: {},
    pendingSignatures: new Set<string>(),
    pendingSteps: new Set<string>(),
    contextAccounts: new Set<string>(),
    closingContext: "",
    forceDebitOnFailedTransfer: false,
  forceDebitMismatch: false,
    failStep: null,
    balanceMode: "enough",
    reserveAccountExists: true,
    reserveAvailable: 2_000_000n,
    reservePending: 0n,
    reservePublicAmount: 5_000_000n,
    escrowAvailable: 0n,
    escrowPending: 0n,
    escrowFunded: false,
    claimState: 0,
    settlementSubmitted: false,
    ledgerCalls: 0,
    attachCalls: 0,
    clearContextsCalls: 0,
    releaseCalls: 0,
    releasedFailedCalls: 0,
    beginFundingCalls: 0,
    prepareFundingCalls: 0,
    recordFundingCalls: 0
  });
  h.payroll = { allocations: [h.allocation] };
}
beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  resetHarness();
});
afterEach(() => vi.restoreAllMocks());

vi.mock("@solana/kit", () => ({
  AccountRole: { READONLY: 0, WRITABLE: 1, READONLY_SIGNER: 2, WRITABLE_SIGNER: 3 },
  address: (value: string) => value,
  blockhash: (value: string) => value,
  createKeyPairSignerFromBytes: vi.fn(async () => ({ address: h.reserveAuthority })),
  createSolanaRpc: vi.fn(() => ({
    getSignatureStatuses: (signatures: string[]) => ({
      send: async () => ({
        value: signatures.map((signature) => ({
          confirmationStatus: h.pendingSignatures.has(String(signature)) ||
            h.pendingSteps.has(stepFor(String(signature))) ? "confirmed" : "finalized",
          err: h.failStep === stepFor(String(signature)) ? { InstructionError: [0, "Custom"] } : null
        }))
      })
    }),
    getLatestBlockhash: () => ({
      send: async () => ({ value: { blockhash: "recent-blockhash", lastValidBlockHeight: 500n } })
    }),
    sendTransaction: () => ({
      send: async () => {
        const signature = "settlement-signature-" + (++h.sendCount);
        h.signatureSteps[signature] = h.currentStep;
        const pending = h.pendingSteps.has(h.currentStep) || h.pendingSignatures.has(signature);
        const failed = h.failStep === h.currentStep;
        if (!pending && !failed) {
          if (h.currentStep === "configure") {
            // Configuration is verified through the transaction status and reserve state.
          } else if (h.currentStep === "apply") {
            if (h.reservePending > 0n) {
              h.reserveAvailable += h.reservePending;
              h.reservePending = 0n;
            }
            h.applyComplete = true;
          } else if (h.currentStep === "deposit") {
            const shortfall = 1_250_000n - h.reserveAvailable;
            h.reservePublicAmount -= shortfall;
            h.reservePending += shortfall;
            h.depositComplete = true;
          } else if (h.currentStep === "apply_escrow") {
            h.escrowAvailable += h.escrowPending;
            h.escrowPending = 0n;
          } else if (h.currentStep === "escrow_funding") {
            h.reserveAvailable -= 1_250_000n;
            h.escrowPending += 1_250_000n;
            h.escrowFunded = true;
          } else if (h.currentStep === "transfer") {
            if (!h.forceDebitOnFailedTransfer || h.failStep !== "transfer") {
              h.escrowAvailable -= h.forceDebitMismatch ? 1_249_999n : 1_250_000n;
              h.claimState = 3;
              h.settlementSubmitted = true;
            }
          } else if (h.currentStep === "finalize_claimed") {
            h.claimState = 1;
          } else if (h.currentStep === "account_setup") {
            h.reserveAccountExists = true;
          } else if (h.currentStep === "funding_proof_setup") {
            h.currentPlanContexts.forEach((context) => h.contextAccounts.add(context));
          } else if (h.currentStep === "payout_proof_setup") {
            h.currentPlanContexts.forEach((context) => h.contextAccounts.add(context));
          } else if (h.currentStep.endsWith("context_close")) {
            h.contextAccounts.delete(h.closingContext);
          }
        } else if (failed && h.currentStep === "transfer" && h.forceDebitOnFailedTransfer) {
          h.escrowAvailable -= 1_250_000n;
        }
        return signature;
      }
    }),
    getTransaction: (signature: string) => ({
      send: async () => finalizedTransaction(String(signature))
    }),
    getAccountInfo: () => ({
      send: async () => ({
        value: {
          owner: h.programId,
          executable: false,
          data: [claimAccountData(), "base64"]
        }
      })
    }),
    getSignaturesForAddress: () => ({ send: async () => [] })
  })),
  createTransactionMessage: () => ({}),
  createTransactionPlanner: () => async (plan: any) => {
    const step = identifyTransactionStep(plan);
    h.executionOrder.push(step);
    h.currentStep = step;
    return plan;
  },
  createTransactionPlanExecutorWithConcurrentLeaves: (options: any) => async (plan: any) => {
    await options.executeTransactionMessage({}, plan);
  },
  partiallySignTransactionMessageWithSigners: async (message: any) => message,
  getBase64EncodedWireTransaction: () => "dGVzdC10cmFuc2FjdGlvbg==",
  setTransactionMessageFeePayerSigner: (_signer: any, message: any) => message,
  setTransactionMessageLifetimeUsingBlockhash: (_lifetime: any, message: any) => message,
  singleInstructionPlan: (instruction: any) => ({ kind: "single", instruction }),
  nonDivisibleSequentialInstructionPlan: (plans: any[]) => ({ kind: "sequential", plans }),
  getAddressEncoder: () => ({ encode: (value: string) => addressBytes(String(value)) }),
  getProgramDerivedAddress: async ({ seeds }: { seeds: Uint8Array[] }) => {
    const first = new TextDecoder().decode(seeds[0]);
    if (first === "workspace") return [h.workspace, 255];
    if (first === "reserve") return [h.reserveState, 255];
    if (first === "claim") return [h.claim, 255];
    throw new Error("Unexpected PDA seed.");
  },
  fetchEncodedAccount: async (_rpc: unknown, accountAddress: string) => {
    if (accountAddress === h.reserveToken) return { exists: h.reserveAccountExists, owner: h.tokenProgram };
    if (accountAddress === h.escrowToken) return { exists: true, owner: h.tokenProgram };
    if (h.contextAccounts.has(accountAddress)) return { exists: true, owner: h.zkProofProgram };
    return { exists: false, owner: h.tokenProgram };
  },
  isSome: (value: unknown) => Boolean(value && typeof value === "object" &&
    (value as { __option?: string }).__option === "Some")
}));

vi.mock("@solana-program/token-2022", () => ({
  TOKEN_2022_PROGRAM_ADDRESS: h.tokenProgram,
  fetchMint: vi.fn(async () => ({
    data: {
      decimals: 6,
      extensions: { __option: "Some", value: [{ __kind: "ConfidentialTransferMint", autoApproveNewAccounts: true }] }
    }
  })),
  fetchToken: vi.fn(async (_rpc: unknown, tokenAddress: string) => ({
    data: {
      owner: tokenAddress === h.destination ? h.contributor : h.reserveAuthority,
      mint: h.mint,
      amount: h.reservePublicAmount,
      extensions: {
        __option: "Some",
        value: [{ __kind: "ImmutableOwner" }, confidentialExtension()]
      }
    }
  })),
  findAssociatedTokenPda: vi.fn(async ({ owner }: { owner: string }) => [
    owner === h.reserveAuthority ? h.reserveToken : h.destination, 255
  ]),
  getConfidentialDepositInstruction: vi.fn(() => ({
    programAddress: h.tokenProgram,
    accounts: [{ address: h.reserveToken }],
    data: new Uint8Array([202])
  }))
}));

vi.mock("@solana-program/token-2022/confidential", () => ({
  deriveConfidentialKeys: vi.fn(async () => ({
    elgamalKeypair: { secretKey: new Uint8Array(32).fill(7) },
    aeKey: new Uint8Array(32).fill(8)
  })),
  fetchConfidentialTransferBalance: vi.fn(async ({ token }: { token: string }) => {
    if (token === h.escrowToken) {
      return { availableBalance: h.escrowAvailable, pendingBalance: h.escrowPending };
    }
    const pending = h.balanceMode === "pending" && !h.applyComplete ? 1_000n : h.reservePending;
    return { availableBalance: h.balanceMode === "low" && !h.depositComplete ? 0n : h.reserveAvailable, pendingBalance: pending };
  }),
  getApplyConfidentialPendingBalanceInstructionFromToken: vi.fn(async ({ token }: { token: string }) => ({
    programAddress: h.tokenProgram,
    accounts: [{ address: token }],
    data: new Uint8Array([token === h.escrowToken ? 204 : 201])
  })),
  getConfidentialTransferInstructionPlan: vi.fn(async ({
    sourceToken, destinationToken
  }: { sourceToken: string; destinationToken: string }) => {
    const funding = destinationToken === h.escrowToken;
    h.currentPlanMode = funding ? "funding" : "payout";
    const contexts = funding ? [h.context1, h.context2, h.context3] : [h.context4, h.context5, h.context6];
    h.currentPlanContexts = contexts;
    return {
      kind: "sequential",
      plans: [
        {
          kind: "single",
          instruction: {
            programAddress: h.zkProofProgram,
            accounts: [{ address: contexts[0] }],
            data: new Uint8Array([3])
          }
        },
        {
          kind: "single",
          instruction: {
            programAddress: h.tokenProgram,
            accounts: [
              { address: sourceToken }, { address: h.mint }, { address: destinationToken },
              { address: h.reserveAuthority }, { address: contexts[0] }
            ],
            data: new Uint8Array([27, 7])
          }
        },
        {
          kind: "sequential",
          plans: contexts.map((context) => ({
            kind: "single",
            instruction: {
              programAddress: h.zkProofProgram,
              accounts: [{ address: context }],
              data: new Uint8Array([1])
            }
          }))
        }
      ]
    };
  }),
  getCreateConfidentialTransferAccountInstructionPlan: vi.fn(async () => ({
    kind: "single",
    instruction: {
      programAddress: h.tokenProgram,
      accounts: [{ address: h.reserveToken }],
      data: new Uint8Array([200])
    }
  }))
}));

vi.mock("@solana-program/zk-elgamal-proof", () => ({
  ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS: h.zkProofProgram,
  closeContextStateProof: vi.fn(({ contextState }: { contextState: string }) => {
    h.closingContext = contextState;
    return {
      programAddress: h.zkProofProgram,
      accounts: [{ address: contextState }],
      data: new Uint8Array([4])
    };
  })
}));

vi.mock("@solana/zk-sdk/bundler", () => {
  class KeyMaterial {
    free = vi.fn();
    static fromBytes() { return new KeyMaterial(); }
    static fromSecretKey() { return new KeyMaterial(); }
  }
  return { AeKey: KeyMaterial, ElGamalKeypair: KeyMaterial, ElGamalSecretKey: KeyMaterial };
});

vi.mock("@paylore/database", () => ({
  getWorkspacePayrollRun: vi.fn(async () => h.payroll),
  getContributorConfidentialAccount: vi.fn(async () => ({
    status: "ready", ownerWalletAddress: h.contributor, tokenAccountAddress: h.destination
  })),
  getPayrollClaimCreationEvidence: vi.fn(async () => ({
    transactionSignature: "claim-creation-signature", programId: h.programId,
    authorityAddress: "WorkspaceAdmin111111111111111111111111",
    allocationCommitment: h.allocationCommitment
  })),
  getWorkspaceReserve: vi.fn(async () => ({ address: h.reserveAuthority })),
  getPayrollClaimEscrow: vi.fn(async () => ({
    workspaceId: input.workspaceId, payrollRunId: input.runId, allocationId: input.allocationId,
    claimId: h.claimId, tokenAccountAddress: h.escrowToken, status: h.escrowStatus,
    fundingSignature: h.fundingSignature, fundingSourceAvailableBefore: h.fundingSourceAvailableBefore,
    fundingSourceAvailableAfter: h.fundingSourceAvailableAfter,
    fundingDestinationAvailableBefore: h.fundingDestinationAvailableBefore,
    fundingDestinationAvailableAfter: h.fundingDestinationAvailableAfter
  })),
  beginPayrollSettlementAttempt: vi.fn(async (_db: unknown, values: any) => {
    if (h.allocation.status === "settlement_pending") return { status: "conflict" };
    h.allocation.status = "settlement_pending";
    h.allocation.settlementSignature = null;
    h.allocation.settlementSourceAvailableBefore = values.sourceAvailableBefore;
    h.allocation.settlementProofContextAddresses = [];
    h.allocation.settlementContextSignatures = [];
    return { status: "started" };
  }),
  beginPayrollClaimEscrowFunding: vi.fn(async () => {
    h.beginFundingCalls++;
    if (h.escrowStatus === "ready") {
      h.escrowStatus = "funding";
      return { status: "started", tokenAccountAddress: h.escrowToken };
    }
    if (h.escrowStatus === "funded") return { status: "funded", tokenAccountAddress: h.escrowToken };
    return { status: "pending", tokenAccountAddress: h.escrowToken, signature: h.fundingSignature ?? undefined };
  }),
  preparePayrollClaimEscrowFundingAttempt: vi.fn(async (_db: unknown, values: any) => {
    h.prepareFundingCalls++;
    h.fundingSourceAvailableBefore = values.sourceAvailableBefore;
    h.fundingDestinationAvailableBefore = values.destinationAvailableBefore;
    return { status: "prepared" };
  }),
  attachPayrollClaimEscrowFundingSignature: vi.fn(async (_db: unknown, values: any) => {
    h.fundingSignature = values.signature;
    h.fundingSourceAvailableBefore = values.sourceAvailableBefore;
    h.fundingDestinationAvailableBefore = values.destinationAvailableBefore;
    return true;
  }),
  recordVerifiedPayrollClaimEscrowFunding: vi.fn(async (_db: unknown, values: any) => {
    h.recordFundingCalls++;
    if (BigInt(values.sourceAvailableBefore) - BigInt(values.sourceAvailableAfter) !== BigInt(h.amountBaseUnits) ||
        BigInt(values.destinationAvailableAfter) - BigInt(values.destinationAvailableBefore) !== BigInt(h.amountBaseUnits)) {
      return { status: "balance_mismatch" };
    }
    h.escrowStatus = "funded";
    h.fundingSourceAvailableAfter = values.sourceAvailableAfter;
    h.fundingDestinationAvailableAfter = values.destinationAvailableAfter;
    return { status: "funded" };
  }),
  resetFailedPayrollClaimEscrowFunding: vi.fn(async (_db: unknown, values: any) => {
    if (h.escrowStatus === "funding" &&
        (values.signature === null ? h.fundingSignature === null : h.fundingSignature === values.signature)) {
      h.escrowStatus = "ready";
      h.fundingSignature = null;
      h.fundingSourceAvailableBefore = null;
      h.fundingSourceAvailableAfter = null;
      h.fundingDestinationAvailableBefore = null;
      h.fundingDestinationAvailableAfter = null;
      return true;
    }
    return h.escrowStatus === "ready";
  }),
  appendPayrollSettlementContextSignature: vi.fn(async (_db: unknown, values: any) => {
    if (!h.allocation.settlementContextSignatures.includes(values.signature)) {
      h.allocation.settlementContextSignatures.push(values.signature);
    }
    return true;
  }),
  attachPayrollSettlementSignature: vi.fn(async (_db: unknown, values: any) => {
    h.attachCalls++;
    h.allocation.settlementSignature = values.settlementSignature;
    h.allocation.settlementSourceAvailableBefore = values.sourceAvailableBefore;
    return { status: "attached" };
  }),
  clearPayrollSettlementProofContexts: vi.fn(async () => {
    h.clearContextsCalls++;
    h.allocation.settlementProofContextAddresses = [];
    h.allocation.settlementContextSignatures = [];
    return true;
  }),
  updatePendingPayrollSettlementBalanceSnapshot: vi.fn(async (_db: unknown, values: any) => {
    h.allocation.settlementSourceAvailableBefore = values.sourceAvailableBefore;
    h.payoutSourceAvailableBefore = values.sourceAvailableBefore;
    return true;
  }),
  setPayrollSettlementProofContexts: vi.fn(async (_db: unknown, values: any) => {
    h.allocation.settlementProofContextAddresses = values.addresses;
    return true;
  }),
  recordVerifiedPayrollClaimSettlement: vi.fn(async (_db: unknown, values: any) => {
    h.ledgerCalls++;
    if (BigInt(values.sourceAvailableBefore) - BigInt(values.sourceAvailableAfter) !== BigInt(h.amountBaseUnits)) {
      return { status: "balance_mismatch" };
    }
    h.allocation.status = "claimed";
    h.allocation.settlementSignature = values.settlementSignature;
    return { status: "claimed" };
  }),
  releaseFailedPayrollSettlementAttempt: vi.fn(async () => {
    h.releasedFailedCalls++;
    h.allocation.status = "unclaimed";
    h.allocation.settlementSignature = null;
    h.allocation.settlementSourceAvailableBefore = null;
    return true;
  }),
  releaseUnsubmittedPayrollSettlementAttempt: vi.fn(async () => {
    h.releaseCalls++;
    h.allocation.status = "unclaimed";
    h.allocation.settlementSignature = null;
    h.allocation.settlementSourceAvailableBefore = null;
    h.allocation.settlementProofContextAddresses = [];
    h.allocation.settlementContextSignatures = [];
    return true;
  })
}));

vi.mock("../config", () => ({
  loadPayloreConfig: () => ({
    PAYLORE_WRAPPED_USDC_MINT: h.mint,
    PAYLORE_PAYROLL_PROGRAM_ID: h.programId,
    PAYLORE_PAYROLL_AMOUNT_COMMITMENT_SECRET: "44".repeat(32),
    PAYLORE_RPC_PRIMARY_PROVIDER: "direct",
    PAYLORE_RPC_PRIMARY_URL: "https://api.devnet.solana.com"
  })
}));
vi.mock("../reserve", () => ({
  withWorkspaceReserveKey: async (_db: unknown, _workspaceId: string, run: (bytes: Uint8Array) => Promise<unknown>) =>
    run(new Uint8Array(64).fill(9))
}));
vi.mock("./payroll-program-verification", () => ({
  verifyPayrollClaimTransaction: vi.fn(async () => undefined)
}));
vi.mock("./payroll-amount-commitment", () => ({
  derivePayrollAmountCommitmentMaterial: vi.fn(() => ({ amountCommitment: h.amountCommitment }))
}));
vi.mock("./payroll-amount-proof-binding", () => {
  class PayrollAmountProofBindingError extends Error {
    code = "payroll_amount_proof_binding_failed";
  }
  return {
    bindAmountCommitmentProof: vi.fn((plan: unknown) => plan),
    PayrollAmountProofBindingError
  };
});
vi.mock("../../components/workspace/confidential-operation-sequence", () => ({
  advanceConfidentialSequence: (sequence: unknown, step: string) => ({ previous: sequence, step }),
  assertConfidentialStepAllowed: vi.fn(),
  createConfidentialSequenceProgress: () => ({ step: "start" })
}));

const input = {
  workspaceId: "workspace-01",
  runId: "run-01",
  allocationId: "allocation-01",
  contributorId: "contributor-01",
  contributorAddress: "ContributorWallet11111111111111111111111",
  contributorUserId: "user-01"
};

function payoutSignature(): string {
  return Object.keys(h.signatureSteps).find((signature) => h.signatureSteps[signature] === "transfer") ?? "";
}

describe("settleContributorPayrollAllocation integration", () => {
  it("funds the Claim escrow first and records a claim only after the exact finalized escrow debit", async () => {
    const result = await settleContributorPayrollAllocation({} as any, input);
    const signature = payoutSignature();

    expect(result).toMatchObject({ status: "claimed", signature, amountBaseUnits: h.amountBaseUnits });
    expect(h.executionOrder).toContain("escrow_funding");
    expect(h.executionOrder).toContain("apply_escrow");
    expect(h.executionOrder).toContain("transfer");
    expect(h.executionOrder.indexOf("escrow_funding")).toBeLessThan(h.executionOrder.indexOf("transfer"));
    expect(h.escrowStatus).toBe("funded");
    expect(h.escrowFunded).toBe(true);
    expect(h.escrowAvailable).toBe(0n);
    expect(h.ledgerCalls).toBe(1);
    expect(h.recordFundingCalls).toBe(1);
    expect(h.attachCalls).toBe(1);
    expect(h.clearContextsCalls).toBe(2);
  });

  it("deposits to the reserve before funding the Claim escrow when transparent funds are available", async () => {
    h.balanceMode = "low";
    h.reserveAvailable = 0n;

    const result = await settleContributorPayrollAllocation({} as any, input);

    expect(result.status).toBe("claimed");
    expect(h.executionOrder).toContain("deposit");
    expect(h.executionOrder.indexOf("deposit")).toBeLessThan(h.executionOrder.indexOf("escrow_funding"));
    expect(h.recordFundingCalls).toBe(1);
    expect(h.ledgerCalls).toBe(1);
  });

  it("applies reserve pending balance before it funds the escrow", async () => {
    h.balanceMode = "pending";
    h.reservePending = 1_000n;

    const result = await settleContributorPayrollAllocation({} as any, input);

    expect(result.status).toBe("claimed");
    expect(h.executionOrder).toContain("apply");
    expect(h.executionOrder.indexOf("apply")).toBeLessThan(h.executionOrder.indexOf("escrow_funding"));
    expect(h.recordFundingCalls).toBe(1);
  });

  it.each([
    {
      name: "reserve confidential-account setup",
      configure: () => { h.reserveAccountExists = false; h.failStep = "account_setup"; },
      code: "reserve_confidential_account_setup_failed"
    },
    {
      name: "reserve program configuration",
      configure: () => { h.failStep = "configure"; },
      code: "reserve_program_configuration_failed"
    },
    {
      name: "reserve pending-balance application",
      configure: () => { h.balanceMode = "pending"; h.reservePending = 1_000n; h.failStep = "apply"; },
      code: "reserve_pending_balance_apply_failed"
    },
    {
      name: "confidential deposit",
      configure: () => { h.balanceMode = "low"; h.reserveAvailable = 0n; h.failStep = "deposit"; },
      code: "reserve_confidential_deposit_failed"
    },
    {
      name: "payout proof setup",
      configure: () => { h.failStep = "payout_proof_setup"; },
      code: "confidential_transfer_proof_setup_failed"
    }
  ])("does not record success when $name fails", async ({ configure, code }) => {
    configure();
    await expect(settleContributorPayrollAllocation({} as any, input))
      .rejects.toMatchObject({ code, statusCode: 503 });
    expect(h.ledgerCalls).toBe(0);
    if (name === "reserve confidential-account setup" || name === "reserve program configuration") {
      expect(h.executionOrder).not.toContain("escrow_funding");
      expect(h.executionOrder).not.toContain("transfer");
      expect(h.escrowFunded).toBe(false);
      expect(h.recordFundingCalls).toBe(0);
    }
  });

  it("releases a failed finalized escrow-funding transfer only when no balance moved", async () => {
    h.failStep = "escrow_funding";
    const result = await settleContributorPayrollAllocation({} as any, input);
    expect(result.status).toBe("retry_ready");
    expect(h.escrowStatus).toBe("ready");
    expect(h.reserveAvailable).toBe(2_000_000n);
    expect(h.escrowAvailable).toBe(0n);
    expect(h.ledgerCalls).toBe(0);
    expect(h.releaseCalls).toBe(1);
  });

  it("keeps an escrow-funding proof failure retryable without posting a claim ledger", async () => {
    h.failStep = "funding_proof_setup";
    const result = await settleContributorPayrollAllocation({} as any, input);
    expect(result.status).toBe("retry_ready");
    expect(h.ledgerCalls).toBe(0);
    expect(h.escrowStatus).toBe("ready");
    expect(h.releaseCalls).toBe(1);
  });

  it("releases a failed finalized payout for safe retry without posting a ledger entry", async () => {
    h.failStep = "transfer";
    const result = await settleContributorPayrollAllocation({} as any, input);
    expect(result).toMatchObject({ status: "retry_ready", signature: payoutSignature() });
    expect(h.releasedFailedCalls).toBe(1);
    expect(h.ledgerCalls).toBe(0);
  });

  it("keeps a finalized payout pending when the private reserve debit is not exact", async () => {
    h.forceDebitMismatch = true;

    const result = await settleContributorPayrollAllocation({} as any, input);

    expect(result).toMatchObject({ status: "pending", signature: payoutSignature() });
    expect(h.claimState).toBe(3);
    expect(h.ledgerCalls).toBe(0);
    expect(h.releasedFailedCalls).toBe(0);
    expect(h.releaseCalls).toBe(0);
    expect(h.clearContextsCalls).toBe(1);
  });

  it("does not release a failed payout when the confidential escrow debit is visible", async () => {
    h.failStep = "transfer";
    h.forceDebitOnFailedTransfer = true;
    const result = await settleContributorPayrollAllocation({} as any, input);
    expect(result).toMatchObject({ status: "pending", signature: payoutSignature() });
    expect(h.ledgerCalls).toBe(0);
    expect(h.releasedFailedCalls).toBe(0);
    expect(h.releaseCalls).toBe(0);
  });

  it("keeps a verified claim settled when proof-context cleanup fails afterward", async () => {
    h.failStep = "payout_context_close";
    const result = await settleContributorPayrollAllocation({} as any, input);
    expect(result).toMatchObject({ status: "claimed", warning: "proof_context_cleanup_pending" });
    expect(h.ledgerCalls).toBe(1);
    expect(h.clearContextsCalls).toBe(0);
  });

  it("reports pending when a submitted payout has not reached finality", async () => {
    h.pendingSteps.add("transfer");
    vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(121_000);
    const result = await settleContributorPayrollAllocation({} as any, input);
    expect(result).toMatchObject({ status: "pending", signature: payoutSignature() });
    expect(h.ledgerCalls).toBe(0);
    expect(h.attachCalls).toBe(1);
  });

  it("reconciles a prior pending signature without re-submitting a transfer", async () => {
    h.escrowStatus = "funded";
    h.escrowFunded = true;
    h.escrowAvailable = 1_250_000n;
    h.allocation.status = "settlement_pending";
    h.allocation.settlementSignature = "prior-settlement-signature";
    h.allocation.settlementSourceAvailableBefore = "1250000";
    h.pendingSignatures.add("prior-settlement-signature");
    const result = await settleContributorPayrollAllocation({} as any, input);
    expect(result).toMatchObject({ status: "pending", signature: "prior-settlement-signature" });
    expect(h.sendCount).toBe(0);
    expect(h.ledgerCalls).toBe(0);
  });

  it("does not begin settlement for a different contributor wallet", async () => {
    await expect(settleContributorPayrollAllocation({} as any, {
      ...input, contributorAddress: "DifferentWallet11111111111111111111111"
    })).rejects.toMatchObject({ code: "payroll_allocation_not_found", statusCode: 404 });
    expect(h.sendCount).toBe(0);
    expect(h.ledgerCalls).toBe(0);
  });

  it("does not create a second claim transfer after a finalized successful replay", async () => {
    await settleContributorPayrollAllocation({} as any, input);
    const sends = h.sendCount;
    const result = await settleContributorPayrollAllocation({} as any, input);
    expect(result.status).toBe("already_settled");
    expect(h.sendCount).toBe(sends);
    expect(h.ledgerCalls).toBe(1);
  });

  it.each(["pending", "failed"] as const)(
    "keeps the claim settlement-pending when finalization is %s and retries only finalization",
    async (mode) => {
      if (mode === "pending") {
        h.pendingSteps.add("finalize_claimed");
        vi.spyOn(Date, "now").mockReturnValueOnce(0).mockReturnValue(121_000);
      } else {
        h.failStep = "finalize_claimed";
      }
      const first = await settleContributorPayrollAllocation({} as any, input);
      expect(first.status).toBe("pending");
      expect(h.claimState).toBe(3);
      expect(h.ledgerCalls).toBe(0);
      expect(Object.values(h.signatureSteps).filter((step) => step === "transfer")).toHaveLength(1);
      h.pendingSteps.delete("finalize_claimed");
      h.failStep = null;
      const sendCountBeforeRetry = h.sendCount;
      const retried = await settleContributorPayrollAllocation({} as any, input);
      expect(retried.status).toBe("claimed");
      expect(h.claimState).toBe(1);
      expect(h.ledgerCalls).toBe(1);
      expect(Object.values(h.signatureSteps).filter((step) => step === "transfer")).toHaveLength(1);
      expect(h.sendCount).toBe(sendCountBeforeRetry + 1);
    }
  );

});
