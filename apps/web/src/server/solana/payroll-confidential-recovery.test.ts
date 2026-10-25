import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { recoverPayrollAllocation } from "./payroll-confidential-recovery";

const h = vi.hoisted(() => ({
  tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  zkProofProgram: "ZkEgalProof111111111111111111111111111111",
  authority: "WorkspaceAdmin111111111111111111111111",
  reserve: "ReserveAuthority1111111111111111111111111",
  reserveToken: "ReserveTokenAccount111111111111111111111",
  escrowToken: "ClaimEscrowToken111111111111111111111111",
  contributor: "ContributorWallet11111111111111111111111",
  mint: "WrappedUsdcMint11111111111111111111111111",
  programId: "4zYM9ZjwbAz9jxQ2C69Z83n1s4wceCPk7VzDLKoUnT93",
  workspace: "WorkspacePda111111111111111111111111111",
  reserveState: "ReserveState111111111111111111111111111",
  claim: "ClaimPda11111111111111111111111111111111",
  context1: "ProofContext111111111111111111111111111",
  context2: "ProofContext222222222222222222222222222",
  context3: "ProofContext333333333333333333333333333",
  claimId: "11".repeat(32),
  commitment: "22".repeat(32),
  amountCommitment: "33".repeat(32),
  amount: "1250",
  allocation: null as any,
  payroll: null as any,
  escrow: null as any,
  currentPlan: null as any,
  recoveryPlan: null as any,
  sentSignatures: [] as string[],
  transferExecuted: false,
  sourceBefore: "2000",
  reserveBefore: "5000",
  sourceAfter: "750",
  reserveAfter: "6250",
  beginCalls: [] as unknown[],
  snapshots: [] as unknown[],
  recoverySignatures: [] as unknown[],
  proofSignatures: [] as unknown[],
  clearedProofs: [] as unknown[],
  recoveryRecords: [] as unknown[],
  currentStep: "other"
}));

const input = {
  workspaceId: "workspace-a",
  runId: "run-a",
  allocationId: "allocation-a",
  actorUserId: "admin-user-a",
  reason: "payroll_correction" as const,
  note: null
};

function discriminator(value: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(value).digest()).slice(0, 8);
}
function sha(value: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(value).digest());
}
function getPlanStep(plan: any): string {
  const instructions: any[] = [];
  const visit = (value: any): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (value.instruction) instructions.push(value.instruction);
    if (value.programAddress && value.data instanceof Uint8Array) instructions.push(value);
    if (Array.isArray(value.plans)) value.plans.forEach(visit);
  };
  visit(plan);
  if (instructions.some((ix) => ix.programAddress === h.programId &&
      Buffer.from(ix.data ?? []).subarray(0, 8).equals(Buffer.from(discriminator("global:recover_claim"))))) return "recovery";
  if (instructions.some((ix) => ix.programAddress === h.tokenProgram && ix.data?.[0] === 27 && ix.data?.[1] === 7)) return "confidential_transfer";
  if (instructions.some((ix) => ix.programAddress === h.zkProofProgram && ix.data?.[0] === 3)) return "proof_setup";
  if (instructions.some((ix) => ix.programAddress === h.tokenProgram && ix.data?.[0] === 201)) return "apply";
  return "other";
}
function reset(): void {
  Object.assign(h, {
    allocation: {
      id: "allocation-a",
      contributorId: "contributor-a",
      contributorWalletAddress: h.contributor,
      amountBaseUnits: h.amount,
      claimId: h.claimId,
      claimAddress: h.claim,
      transactionSignature: "claim-creation-signature",
      amountCommitment: h.amountCommitment,
      status: "unclaimed"
    },
    payroll: null,
    escrow: {
      workspaceId: "workspace-a",
      payrollRunId: "run-a",
      allocationId: "allocation-a",
      claimId: h.claimId,
      tokenAccountAddress: h.escrowToken,
      status: "funded",
      recoverySignature: null,
      recoveryApplySignature: null,
      recoveryReason: null,
      recoveryReasonNote: null,
      recoveryProofContextAddresses: [],
      recoveryContextSignatures: [],
      recoverySourceAvailableBefore: null,
      recoverySourceAvailableAfter: null,
      recoveryDestinationAvailableBefore: null,
      recoveryDestinationAvailableAfter: null
    },
    currentPlan: null,
    recoveryPlan: null,
    sentSignatures: [],
    transferExecuted: false,
    sourceBefore: "2000",
    reserveBefore: "5000",
    sourceAfter: "750",
    reserveAfter: "6250",
    beginCalls: [],
    snapshots: [],
    recoverySignatures: [],
    proofSignatures: [],
    clearedProofs: [],
    recoveryRecords: [],
    currentStep: "other"
  });
  h.payroll = {
    run: { allocationCommitment: h.commitment },
    allocations: [h.allocation]
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  reset();
});

vi.mock("@solana/kit", () => ({
  AccountRole: { READONLY: 0, WRITABLE: 1, READONLY_SIGNER: 2, WRITABLE_SIGNER: 3 },
  address: (value: string) => value,
  blockhash: (value: string) => value,
  createKeyPairSignerFromBytes: vi.fn(async () => ({ address: h.reserve })),
  createSolanaRpc: vi.fn(() => ({
    getSignatureStatuses: (signatures: string[]) => ({
      send: async () => ({
        value: signatures.map(() => ({ confirmationStatus: "finalized", err: null }))
      })
    }),
    getLatestBlockhash: () => ({
      send: async () => ({ value: { blockhash: "recent-blockhash", lastValidBlockHeight: 500n } })
    }),
    sendTransaction: () => ({
      send: async () => {
        const step = getPlanStep(h.currentPlan);
        const signature = "recovery-signature-" + (h.sentSignatures.length + 1);
        h.currentStep = step;
        h.sentSignatures.push(signature);
        if (step === "recovery") {
          h.transferExecuted = true;
          h.recoveryPlan = h.currentPlan;
        }
        return signature;
      }
    }),
    getAccountInfo: () => ({ send: async () => ({ value: null }) })
  })),
  createTransactionMessage: () => ({}),
  createTransactionPlanner: () => async (plan: any) => {
    h.currentPlan = plan;
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
  getAddressEncoder: () => ({ encode: (value: string) => sha(value) }),
  getProgramDerivedAddress: async ({ seeds }: { seeds: Uint8Array[] }) => {
    const first = new TextDecoder().decode(seeds[0]);
    if (first === "workspace") return [h.workspace, 255];
    if (first === "reserve") return [h.reserveState, 255];
    if (first === "claim") return [h.claim, 255];
    throw new Error("Unexpected PDA seed.");
  },
  fetchEncodedAccount: async (_rpc: unknown, accountAddress: string) => {
    if (accountAddress === h.escrowToken || accountAddress === h.reserveToken) {
      return { exists: true, owner: h.tokenProgram };
    }
    return { exists: false, owner: h.zkProofProgram };
  }
}));

vi.mock("@solana-program/token-2022", () => ({
  TOKEN_2022_PROGRAM_ADDRESS: h.tokenProgram,
  fetchMint: vi.fn(async () => ({
    data: {
      decimals: 6,
      extensions: [{ __kind: "ConfidentialTransferMint", autoApproveNewAccounts: true }]
    }
  })),
  fetchToken: vi.fn(async (_rpc: unknown, tokenAddress: string) => ({
    data: {
      owner: h.reserve,
      mint: h.mint,
      amount: 100_000n,
      extensions: [{
        __kind: "ConfidentialTransferAccount",
        approved: true,
        allowConfidentialCredits: true
      }],
      tokenAddress
    }
  })),
  findAssociatedTokenPda: vi.fn(async () => [h.reserveToken, 255])
}));

vi.mock("@solana-program/token-2022/confidential", () => ({
  deriveConfidentialKeys: vi.fn(async () => ({
    elgamalKeypair: { secretKey: new Uint8Array(32).fill(7) },
    aeKey: new Uint8Array(32).fill(8)
  })),
  fetchConfidentialTransferBalance: vi.fn(async ({ token }: { token: string }) => {
    if (token === h.escrowToken) {
      return {
        availableBalance: BigInt(h.transferExecuted ? h.sourceAfter : h.sourceBefore),
        pendingBalance: 0n
      };
    }
    return {
      availableBalance: BigInt(h.transferExecuted ? h.reserveAfter : h.reserveBefore),
      pendingBalance: 0n
    };
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
            { address: h.escrowToken }, { address: h.mint }, { address: h.reserveToken },
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
  }))
}));

vi.mock("@solana-program/zk-elgamal-proof", () => ({
  ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS: h.zkProofProgram,
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
  getPayrollClaimCreationEvidence: vi.fn(async () => ({
    programId: h.programId,
    authorityAddress: h.authority,
    allocationCommitment: h.commitment,
    transactionSignature: "claim-creation-signature"
  })),
  getWorkspaceReserve: vi.fn(async () => ({ address: h.reserve })),
  getPayrollClaimEscrow: vi.fn(async () => h.escrow),
  beginPayrollRecoveryAttempt: vi.fn(async (_db: unknown, input: unknown) => {
    h.beginCalls.push(input);
    h.allocation.status = "recovery_pending";
    h.escrow.status = "recovery_pending";
    return { status: "started" };
  }),
  setPayrollClaimEscrowRecoveryBalanceSnapshot: vi.fn(async (_db: unknown, input: any) => {
    h.snapshots.push(input);
    h.escrow.recoverySourceAvailableBefore = input.sourceAvailableBefore;
    h.escrow.recoveryDestinationAvailableBefore = input.reserveAvailableBefore;
    return { status: "prepared" };
  }),
  setPayrollClaimEscrowProofContexts: vi.fn(async (_db: unknown, input: any) => {
    h.escrow.recoveryProofContextAddresses = input.addresses;
    return true;
  }),
  appendPayrollClaimEscrowContextSignature: vi.fn(async (_db: unknown, input: any) => {
    h.proofSignatures.push(input);
    h.escrow.recoveryContextSignatures.push(input.signature);
    return true;
  }),
  attachPayrollClaimEscrowRecoverySignature: vi.fn(async (_db: unknown, input: any) => {
    h.recoverySignatures.push(input);
    h.escrow.recoverySignature = input.signature;
    return true;
  }),
  attachPayrollClaimEscrowRecoveryApplySignature: vi.fn(async () => true),
  clearPayrollClaimEscrowRecoveryApplySignature: vi.fn(async () => true),
  clearPayrollClaimEscrowProofContexts: vi.fn(async (_db: unknown, input: any) => {
    h.clearedProofs.push(input);
    h.escrow.recoveryProofContextAddresses = [];
    return true;
  }),
  recordPayrollRecovery: vi.fn(async (_db: unknown, input: any) => {
    h.recoveryRecords.push(input);
    h.allocation.status = "recovered";
    h.escrow.status = "recovered";
    h.escrow.recoverySourceAvailableAfter = input.sourceAvailableAfter;
    h.escrow.recoveryDestinationAvailableAfter = input.reserveAvailableAfter;
    return { status: "recovered" };
  }),
  releasePayrollRecoveryAttempt: vi.fn(async () => true),
  resetFailedPayrollRecoveryAttempt: vi.fn(async () => true)
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
  getFinalizedPayrollClaimState: vi.fn(async () => h.transferExecuted ? "recovered" : "unclaimed"),
  verifyPayrollRecoveryTransaction: vi.fn(async () => undefined)
}));

vi.mock("./payroll-amount-commitment", () => ({
  derivePayrollAmountCommitmentMaterial: vi.fn(() => ({
    amountCommitment: h.amountCommitment,
    opening: new Uint8Array(32).fill(4)
  }))
}));

vi.mock("./payroll-confidential-settlement-policy", () => ({
  classifyTransactionFinality: (status: any) =>
    !status || status.confirmationStatus !== "finalized"
      ? "pending"
      : status.err == null ? "finalized" : "failed",
  getProofContextAddresses: (plan: any) => {
    const found: string[] = [];
    const visit = (value: any) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      if (value.instruction?.programAddress === h.zkProofProgram) {
        const first = value.instruction.accounts?.[0]?.address;
        if (typeof first === "string") found.push(first);
      }
      if (Array.isArray(value.plans)) value.plans.forEach(visit);
    };
    visit(plan);
    return [...new Set(found)];
  }
}));

describe("confidential payroll recovery orchestration", () => {
  it("moves the exact unclaimed allocation from its escrow to reserve and records only reconciled finality", async () => {
    const result = await recoverPayrollAllocation({} as any, input);

    expect(result).toMatchObject({
      status: "recovered",
      signature: "recovery-signature-2"
    });
    expect(h.beginCalls).toHaveLength(1);
    expect(h.snapshots[0]).toMatchObject({
      sourceAvailableBefore: "2000",
      reserveAvailableBefore: "5000"
    });
    expect(h.transferExecuted).toBe(true);
    expect(h.recoveryPlan.kind).toBe("sequential");
    expect(h.recoveryPlan.plans).toHaveLength(2);
    expect(h.recoveryPlan.plans[0].accounts[0].address).toBe(h.escrowToken);
    expect(h.recoveryPlan.plans[0].accounts[2].address).toBe(h.reserveToken);
    expect(h.recoveryPlan.plans[1].programAddress).toBe(h.programId);
    expect(Buffer.from(h.recoveryPlan.plans[1].data).subarray(0, 8))
      .toEqual(Buffer.from(discriminator("global:recover_claim")));
    expect(h.recoveryRecords).toHaveLength(1);
    expect(h.recoveryRecords[0]).toMatchObject({
      workspaceId: input.workspaceId,
      runId: input.runId,
      allocationId: input.allocationId,
      actorUserId: input.actorUserId,
      reason: input.reason,
      signature: "recovery-signature-2",
      sourceAvailableBefore: "2000",
      sourceAvailableAfter: "750",
      reserveAvailableBefore: "5000",
      reserveAvailableAfter: "6250"
    });
    expect(h.clearedProofs).toHaveLength(1);
  });

  it("does not record recovery when owner-decrypted balance deltas differ from the allocation", async () => {
    h.sourceAfter = "749";

    const result = await recoverPayrollAllocation({} as any, input);

    expect(result.status).toBe("pending");
    expect(h.transferExecuted).toBe(true);
    expect(h.recoveryRecords).toHaveLength(0);
  });

  it("reconciles a duplicate request from the durable recovered record without a second transfer", async () => {
    h.allocation.status = "recovered";
    h.escrow.status = "recovered";
    h.escrow.recoverySignature = "prior-recovery-signature";

    const result = await recoverPayrollAllocation({} as any, input);

    expect(result).toEqual({
      status: "already_reconciled",
      signature: "prior-recovery-signature"
    });
    expect(h.sentSignatures).toHaveLength(0);
    expect(h.recoveryRecords).toHaveLength(0);
  });

  it("rejects an Other reason without a note before opening custody or sending a transaction", async () => {
    await expect(recoverPayrollAllocation({} as any, {
      ...input,
      reason: "other",
      note: "   "
    })).rejects.toMatchObject({
      code: "payroll_recovery_reason_required",
      statusCode: 400
    });
    expect(h.sentSignatures).toHaveLength(0);
    expect(h.beginCalls).toHaveLength(0);
  });

  it("never attempts recovery for an already claimed allocation", async () => {
    h.allocation.status = "claimed";

    await expect(recoverPayrollAllocation({} as any, input)).rejects.toMatchObject({
      code: "payroll_allocation_not_recoverable",
      statusCode: 409
    });
    expect(h.sentSignatures).toHaveLength(0);
    expect(h.beginCalls).toHaveLength(0);
  });
});
