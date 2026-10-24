import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { settleContributorPayrollAllocation } from "./payroll-confidential-settlement";

const h = vi.hoisted(() => ({
  tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  zkProofProgram: "ZkEgalProof111111111111111111111111111111",
  reserveAuthority: "ReserveAuthority1111111111111111111111111",
  contributor: "ContributorWallet11111111111111111111111",
  destination: "ContributorTokenAccount11111111111111111",
  reserveToken: "ReserveTokenAccount111111111111111111111",
  mint: "WrappedUsdcMint11111111111111111111111111",
  programId: "PayloreProgram11111111111111111111111111",
  workspace: "WorkspacePda111111111111111111111111111",
  reserveState: "ReserveState111111111111111111111111111",
  claim: "ClaimPda11111111111111111111111111111111",
  context1: "ProofContext111111111111111111111111111",
  context2: "ProofContext222222222222222222222222222",
  context3: "ProofContext333333333333333333333333333",
  claimId: "11".repeat(32),
  allocationCommitment: "22".repeat(32),
  amountCommitment: "33".repeat(32),
  amountBaseUnits: "1250000",
  allocation: null as any,
  payroll: null as any,
  nextSteps: [] as string[],
  executionOrder: [] as string[],
  currentStep: "other",
  sendCount: 0,
  signatureSteps: {} as Record<string, string>,
  pendingSignatures: new Set<string>(),
  failStep: null as string | null,
  balanceMode: "enough",
  reserveAccountExists: true,
  applyComplete: false,
  depositComplete: false,
  settlementSubmitted: false,
  claimState: 1,
  ledgerCalls: 0,
  attachCalls: 0,
  clearContextsCalls: 0,
  releaseCalls: 0,
  releasedFailedCalls: 0
}));

const SYSVAR_INSTRUCTIONS = "Sysvar1nstructions1111111111111111111111111";

function hash(value: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(value).digest());
}

function addressBytes(value: string): Uint8Array {
  return hash(value);
}

function anchorDiscriminator(value: string): Uint8Array {
  return hash(value).slice(0, 8);
}

function hexBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/.{2}/g) ?? [], (part) => Number.parseInt(part, 16));
}

function encodeBase58(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let value = 0n;
  for (const byte of bytes) value = value * 256n + BigInt(byte);
  let encoded = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    encoded = alphabet[remainder] + encoded;
    value /= 58n;
  }
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes++;
  return "1".repeat(leadingZeroes) + encoded;
}

function claimAccountData(): string {
  const data = new Uint8Array(170);
  data.set(anchorDiscriminator("account:ClaimState"), 0);
  data.set(addressBytes(h.workspace), 8);
  data.set(addressBytes(h.contributor), 40);
  data.set(hexBytes(h.claimId), 72);
  data.set(hexBytes(h.allocationCommitment), 104);
  data.set(hexBytes(h.amountCommitment), 136);
  data[168] = h.claimState;
  data[169] = 255;
  return Buffer.from(data).toString("base64");
}

function finalizedTransaction(signature: string) {
  return {
    slot: 42,
    meta: { err: null },
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [h.reserveAuthority],
        instructions: [
          {
            programId: h.tokenProgram,
            accounts: [h.reserveToken, h.mint, h.destination, "TransferAuthority111", h.context1],
            data: encodeBase58(new Uint8Array([27, 7]))
          },
          {
            programId: h.programId,
            accounts: [
              h.contributor, h.workspace, h.reserveState, h.reserveAuthority, h.reserveToken,
              h.mint, h.destination, h.claim, SYSVAR_INSTRUCTIONS, h.context1
            ],
            data: encodeBase58(anchorDiscriminator("global:mark_claimed"))
          }
        ]
      }
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

  if (has(h.tokenProgram, 27, 7)) return "transfer";
  if (has(h.tokenProgram, 202)) return "deposit";
  if (has(h.tokenProgram, 201)) return "apply";
  if (has(h.tokenProgram, 200)) return "account_setup";
  if (has(h.zkProofProgram, 3)) return "proof_setup";
  if (instructions.some((instruction) =>
    instruction.programAddress === h.programId &&
    instruction.data instanceof Uint8Array &&
    Buffer.from(instruction.data).equals(anchorDiscriminator("global:configure_workspace_reserve"))
  )) return "configure";
  return "other";
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
    payroll: null,
    nextSteps: ["configure", "proof_setup", "transfer"],
    executionOrder: [],
    currentStep: "other",
    sendCount: 0,
    signatureSteps: {},
    pendingSignatures: new Set<string>(),
    failStep: null,
    balanceMode: "enough",
    reserveAccountExists: true,
    applyComplete: false,
    depositComplete: false,
    settlementSubmitted: false,
    claimState: 1,
    ledgerCalls: 0,
    attachCalls: 0,
    clearContextsCalls: 0,
    releaseCalls: 0,
    releasedFailedCalls: 0
  });
  h.payroll = { allocations: [h.allocation] };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetHarness();
});

vi.mock("@solana/kit", () => ({
  AccountRole: { READONLY: 0, WRITABLE: 1, READONLY_SIGNER: 2, WRITABLE_SIGNER: 3 },
  address: (value: string) => value,
  blockhash: (value: string) => value,
  createKeyPairSignerFromBytes: vi.fn(async () => ({ address: h.reserveAuthority })),
  createSolanaRpc: vi.fn(() => ({
    getSignatureStatuses: (signatures: string[]) => ({
      send: async () => ({
        value: signatures.map((signature) => {
          if (h.pendingSignatures.has(String(signature))) {
            return { confirmationStatus: "confirmed", err: null };
          }
          const failed = h.failStep !== null && h.signatureSteps[String(signature)] === h.failStep;
          return { confirmationStatus: "finalized", err: failed ? { InstructionError: [0, "Custom"] } : null };
        })
      })
    }),
    getLatestBlockhash: () => ({ send: async () => ({ value: { blockhash: "recent-blockhash", lastValidBlockHeight: 500n } }) }),
    sendTransaction: () => ({
      send: async () => {
        const signature = "settlement-signature-" + (++h.sendCount);
        h.signatureSteps[signature] = h.currentStep;
        if (h.currentStep === "apply" && h.failStep !== "apply") h.applyComplete = true;
        if (h.currentStep === "deposit" && h.failStep !== "deposit") h.depositComplete = true;
        if (h.currentStep === "transfer" && h.failStep !== "transfer") h.settlementSubmitted = true;
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
    })
  })),
  createTransactionMessage: () => ({}),
  createTransactionPlanner: () => async (plan: any) => {
    const step = identifyTransactionStep(plan);
    h.executionOrder.push(step);
    const expected = h.nextSteps.shift();
    if (expected !== undefined && expected !== step) {
      throw new Error(`Unexpected settlement order: expected ${expected}, received ${step}.`);
    }
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
    return { exists: false, owner: h.tokenProgram };
  },
  isSome: (value: unknown) => value !== null && value !== undefined
}));

vi.mock("@solana-program/token-2022", () => ({
  h.tokenProgram,
  fetchMint: vi.fn(async () => ({
    data: { decimals: 6, extensions: [{ __kind: "ConfidentialTransferMint", autoApproveNewAccounts: true }] }
  })),
  fetchToken: vi.fn(async (_rpc: unknown, tokenAddress: string) => ({
    data: {
      owner: tokenAddress === h.reserveToken ? h.reserveAuthority : h.contributor,
      mint: h.mint,
      amount: 5_000_000n,
      extensions: [{ __kind: "ConfidentialTransferAccount", approved: true, allowConfidentialCredits: true }]
    }
  })),
  findAssociatedTokenPda: vi.fn(async ({ owner }: { owner: string }) => [
    owner === h.reserveAuthority ? h.reserveToken : h.destination,
    255
  ]),
  getConfidentialDepositInstruction: vi.fn(() => ({
    programAddress: h.tokenProgram,
    accounts: [],
    data: new Uint8Array([202])
  }))
}));

vi.mock("@solana-program/token-2022/confidential", () => ({
  deriveConfidentialKeys: vi.fn(async () => ({
    elgamalKeypair: { secretKey: new Uint8Array(32).fill(7) },
    aeKey: new Uint8Array(32).fill(8)
  })),
  fetchConfidentialTransferBalance: vi.fn(async () => {
    let availableBalance = 2_000_000n;
    if (h.settlementSubmitted) {
      availableBalance = h.failStep === "transfer" ? 2_000_000n : 750_000n;
    } else if (h.balanceMode === "low" && !h.depositComplete) {
      availableBalance = 0n;
    }
    const pendingBalance = h.balanceMode === "pending" && !h.applyComplete ? 1_000n : 0n;
    return { availableBalance, pendingBalance };
  }),
  getApplyConfidentialPendingBalanceInstructionFromToken: vi.fn(() => ({
    programAddress: h.tokenProgram,
    accounts: [],
    data: new Uint8Array([201])
  })),
  getConfidentialTransferInstructionPlan: vi.fn(async () => ({
    kind: "sequential",
    plans: [
      {
        kind: "single",
        instruction: {
          programAddress: h.zkProofProgram,
          accounts: [{ address: h.context1 }],
          data: new Uint8Array([3])
        }
      },
      {
        kind: "single",
        instruction: {
          programAddress: h.tokenProgram,
          accounts: [
            { address: h.reserveToken }, { address: h.mint }, { address: h.destination },
            { address: "TransferAuthority111" }, { address: h.context1 }
          ],
          data: new Uint8Array([27, 7])
        }
      },
      {
        kind: "sequential",
        plans: [h.context1, h.context2, h.context3].map((context) => ({
          kind: "single",
          instruction: {
            programAddress: h.zkProofProgram,
            accounts: [{ address: context }],
            data: new Uint8Array([1])
          }
        }))
      }
    ]
  })),
  getCreateConfidentialTransferAccountInstructionPlan: vi.fn(async () => ({
    kind: "single",
    instruction: {
      programAddress: h.tokenProgram,
      accounts: [],
      data: new Uint8Array([200])
    },
    testStep: "account_setup"
  }))
}));

vi.mock("@solana-program/zk-elgamal-proof", () => ({
  h.zkProofProgram,
  closeContextStateProof: vi.fn(() => ({
    programAddress: h.zkProofProgram,
    accounts: [],
    data: new Uint8Array([4])
  }))
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
    status: "ready",
    ownerWalletAddress: h.contributor,
    tokenAccountAddress: h.destination
  })),
  getPayrollClaimCreationEvidence: vi.fn(async () => ({
    transactionSignature: "claim-creation-signature",
    programId: h.programId,
    authorityAddress: "WorkspaceAdmin111111111111111111111111",
    allocationCommitment: h.allocationCommitment
  })),
  getWorkspaceReserve: vi.fn(async () => ({ address: h.reserveAuthority })),
  beginPayrollSettlementAttempt: vi.fn(async () => ({ status: "started" })),
  appendPayrollSettlementContextSignature: vi.fn(async () => true),
  attachPayrollSettlementSignature: vi.fn(async () => { h.attachCalls++; return { status: "attached" }; }),
  clearPayrollSettlementProofContexts: vi.fn(async () => { h.clearContextsCalls++; return true; }),
  updatePendingPayrollSettlementBalanceSnapshot: vi.fn(async () => true),
  setPayrollSettlementProofContexts: vi.fn(async () => true),
  recordVerifiedPayrollClaimSettlement: vi.fn(async () => { h.ledgerCalls++; return { status: "claimed" }; }),
  releaseFailedPayrollSettlementAttempt: vi.fn(async () => { h.releasedFailedCalls++; return true; }),
  releaseUnsubmittedPayrollSettlementAttempt: vi.fn(async () => { h.releaseCalls++; return true; })
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

describe("settleContributorPayrollAllocation integration", () => {
  it("records a claim only after the finalized transfer and exact reserve debit agree", async () => {
    const result = await settleContributorPayrollAllocation({} as any, input);

    expect(result).toMatchObject({
      status: "claimed",
      signature: "settlement-signature-3",
      amountBaseUnits: h.amountBaseUnits
    });
    expect(h.settlementSubmitted).toBe(true);
    expect(h.executionOrder).toEqual(["configure", "proof_setup", "transfer"]);
    expect(h.attachCalls).toBe(1);
    expect(h.ledgerCalls).toBe(1);
    expect(h.clearContextsCalls).toBe(1);
  });

  it("completes a successful deposit path before the confidential transfer", async () => {
    h.balanceMode = "low";
    h.nextSteps = ["configure", "deposit", "proof_setup", "transfer"];

    const result = await settleContributorPayrollAllocation({} as any, input);

    expect(result.status).toBe("claimed");
    expect(h.depositComplete).toBe(true);
    expect(h.executionOrder).toEqual(["configure", "deposit", "proof_setup", "transfer"]);
    expect(h.ledgerCalls).toBe(1);
  });

  it("applies pending reserve balance before proceeding to settlement", async () => {
    h.balanceMode = "pending";
    h.nextSteps = ["configure", "apply", "proof_setup", "transfer"];

    const result = await settleContributorPayrollAllocation({} as any, input);

    expect(result.status).toBe("claimed");
    expect(h.applyComplete).toBe(true);
    expect(h.executionOrder).toEqual(["configure", "apply", "proof_setup", "transfer"]);
    expect(h.ledgerCalls).toBe(1);
  });

  it.each([
    {
      name: "reserve confidential-account setup",
      configure: () => {
        h.reserveAccountExists = false;
        h.failStep = "account_setup";
        h.nextSteps = ["account_setup"];
      },
      code: "reserve_confidential_account_setup_failed"
    },
    {
      name: "reserve instruction configuration",
      configure: () => {
        h.failStep = "configure";
        h.nextSteps = ["configure"];
      },
      code: "reserve_program_configuration_failed"
    },
    {
      name: "pending-balance application",
      configure: () => {
        h.balanceMode = "pending";
        h.failStep = "apply";
        h.nextSteps = ["configure", "apply"];
      },
      code: "reserve_pending_balance_apply_failed"
    },
    {
      name: "confidential deposit",
      configure: () => {
        h.balanceMode = "low";
        h.failStep = "deposit";
        h.nextSteps = ["configure", "deposit"];
      },
      code: "reserve_confidential_deposit_failed"
    },
    {
      name: "proof-context setup",
      configure: () => {
        h.failStep = "proof_setup";
        h.nextSteps = ["configure", "proof_setup"];
      },
      code: "confidential_transfer_proof_setup_failed"
    }
  ])("does not report success when $name fails", async ({ configure, code }) => {
    configure();

    await expect(settleContributorPayrollAllocation({} as any, input))
      .rejects.toMatchObject({ code, statusCode: 503 });
    expect(h.ledgerCalls).toBe(0);
    expect(h.releaseCalls).toBe(1);
  });

  it("releases a failed finalized transfer for a safe retry without posting a ledger entry", async () => {
    h.failStep = "transfer";
    h.claimState = 0;
    h.nextSteps = ["configure", "proof_setup", "transfer"];

    const result = await settleContributorPayrollAllocation({} as any, input);

    expect(result).toMatchObject({ status: "retry_ready", signature: "settlement-signature-3" });
    expect(h.releasedFailedCalls).toBe(1);
    expect(h.ledgerCalls).toBe(0);
  });

  it("returns pending for a prior settlement whose finality is not available yet", async () => {
    h.allocation.status = "settlement_pending";
    h.allocation.settlementSignature = "prior-settlement-signature";
    h.allocation.settlementProofContextAddresses = [h.context1, h.context2, h.context3];
    h.pendingSignatures.add("prior-settlement-signature");
    h.nextSteps = [];

    const result = await settleContributorPayrollAllocation({} as any, input);

    expect(result).toMatchObject({ status: "pending", signature: "prior-settlement-signature" });
    expect(h.ledgerCalls).toBe(0);
    expect(h.attachCalls).toBe(0);
  });

  it("does not begin settlement for a contributor wallet that does not own the allocation", async () => {
    await expect(settleContributorPayrollAllocation({} as any, {
      ...input,
      contributorAddress: "DifferentWallet11111111111111111111111"
    })).rejects.toMatchObject({ code: "payroll_allocation_not_found", statusCode: 404 });
    expect(h.sendCount).toBe(0);
    expect(h.ledgerCalls).toBe(0);
  });
});
