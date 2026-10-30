import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertWorkspaceReserveFundingGasTankReady,
  completeWorkspaceReserveConfidentialFunding,
  getWorkspaceConfidentialReserveSnapshot,
  initializeWorkspaceConfidentialReserveAccount,
  WorkspaceReserveInitializationError
} from "./workspace-reserve";

const h = vi.hoisted(() => ({
  tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  authority: "11111111111111111111111111111111",
  gasTank: "GasTankSigner11111111111111111111111111111",
  gasTankExists: true,
  gasTankBalanceLamports: 1_000_000_000n,
  gasTankBalanceError: null as Error | null,
  gasTankBalanceCalls: 0,
  gasTankBalanceFailsOnCall: 0,
  sendTransactionError: null as Error | null,
  feePayerAddresses: [] as string[],
  registeredSignerAddresses: [] as string[][],
  registeredInstructionSigners: [] as string[][],
  setupArgs: null as null | { payer: string; owner: string },
  configureAccounts: null as null | any[],
  reserve: "ReserveAuthority1111111111111111111111111",
  reserveToken: "ReserveTokenAccount111111111111111111111",
  mint: "WrappedUsdcMint11111111111111111111111111",
  programId: "4zYM9ZjwbAz9jxQ2C69Z83n1s4wceCPk7VzDLKoUnT93",
  workspace: "WorkspacePda111111111111111111111111111",
  reserveState: "ReserveState111111111111111111111111111",
  accountReady: true,
  accountOwner: "",
  workspaceInitialized: true,
  reserveConfigured: false,
  publicBalanceBaseUnits: 0n,
  availableBalanceBaseUnits: 0n,
  pendingBalanceBaseUnits: 0n,
  currentPlan: null as any,
  submittedSteps: [] as string[],
  setupSignature: "setup-signature",
  setupCalls: 0,
  configCalls: 0,
  attachCalls: [] as Array<{phase:string;signature:string}>,
  clearCalls: [] as Array<{phase:string;signature:string}>,
  signatureFinality: {} as Record<string, "finalized" | "failed" | "pending">,
  feeReservationCalls: [] as unknown[],
  feeReservationResult: "reserved" as string,
  currentFeeReservationOperationData: null as Record<string, unknown> | null,
  transactionPublicBalanceBefore: 0n,
  transactionAmount: 0n,
  lastTransactionType: ""
}));

function sha(value: string): Uint8Array {
  return new Uint8Array(createHash("sha256").update(value).digest());
}
function discriminator(value: string): Uint8Array {
  return sha(value).slice(0, 8);
}
function encode(value: string): Uint8Array {
  return sha(value);
}
function b64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}
function base58(value: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const hex = Buffer.from(value).toString("hex");
  let number = hex ? BigInt("0x" + hex) : 0n;
  let result = "";
  while (number > 0n) {
    result = alphabet[Number(number % 58n)] + result;
    number /= 58n;
  }
  const zeroes = value.findIndex((byte) => byte !== 0);
  return "1".repeat(zeroes < 0 ? value.length : zeroes) + result;
}
function workspaceAccount(): [string, "base64"] {
  const workspaceId = "workspace-a";
  const id = new TextEncoder().encode(workspaceId);
  const seed = sha("paylore:workspace:v1:" + workspaceId);
  const data = new Uint8Array(141);
  data.set(discriminator("account:WorkspaceState"), 0);
  data.set(encode(h.authority), 8);
  new DataView(data.buffer).setUint32(40, id.length, true);
  data.set(id, 44);
  data.set(seed, 44 + id.length);
  data[44 + id.length + 32] = 255;
  return [b64(data), "base64"];
}
function reserveStateAccount(): [string, "base64"] {
  const data = new Uint8Array(137);
  data.set(discriminator("account:WorkspaceReserveState"), 0);
  data.set(encode(h.workspace), 8);
  data.set(encode(h.reserve), 40);
  data.set(encode(h.reserveToken), 72);
  data.set(encode(h.mint), 104);
  data[136] = 255;
  return [b64(data), "base64"];
}
function getPlanStep(plan: any): string {
  const nodes: any[] = [];
  const visit = (value: any): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    if (value.instruction) nodes.push(value.instruction);
    if (value.programAddress && value.data instanceof Uint8Array) nodes.push(value);
    if (Array.isArray(value.plans)) value.plans.forEach(visit);
  };
  visit(plan);
  if (nodes.some((ix) => ix.programAddress === h.tokenProgram && ix.data?.[0] === 200)) return "account_setup";
  if (nodes.some((ix) => ix.programAddress === h.tokenProgram && ix.data?.[0] === 201)) return "deposit";
  if (nodes.some((ix) => ix.programAddress === h.tokenProgram && ix.data?.[0] === 202)) {
    return String(h.currentFeeReservationOperationData?.stage ?? "").startsWith("preapply")
      ? "preapply_apply"
      : "apply";
  }
  if (nodes.some((ix) =>
    ix.programAddress === h.programId &&
    Buffer.from(ix.data ?? []).equals(Buffer.from(discriminator("global:configure_workspace_reserve")))
  )) return "program_configure";
  return "other";
}
function reset(): void {
  Object.assign(h, {
    accountReady: true,
    accountOwner: h.tokenProgram,
    gasTankExists: true,
    gasTankBalanceLamports: 1_000_000_000n,
    gasTankBalanceError: null,
    gasTankBalanceCalls: 0,
    gasTankBalanceFailsOnCall: 0,
    sendTransactionError: null,
    feePayerAddresses: [],
    registeredSignerAddresses: [],
    registeredInstructionSigners: [],
    setupArgs: null,
    configureAccounts: null,
    workspaceInitialized: true,
    reserveConfigured: false,
    publicBalanceBaseUnits: 0n,
    availableBalanceBaseUnits: 0n,
    pendingBalanceBaseUnits: 0n,
    currentPlan: null,
    submittedSteps: [],
    setupCalls: 0,
    configCalls: 0,
    attachCalls: [],
    clearCalls: [],
    signatureFinality: {},
    feeReservationCalls: [],
    feeReservationResult: "reserved",
    currentFeeReservationOperationData: null,
    transactionPublicBalanceBefore: 0n,
    transactionAmount: 0n,
    lastTransactionType: ""
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  reset();
});

vi.mock("@solana/kit", () => ({
  AccountRole: { READONLY: 0, WRITABLE: 1, READONLY_SIGNER: 2, WRITABLE_SIGNER: 3 },
  address: (value: string) => value,
  isSome: (value: { __option?: string } | null | undefined) => value?.__option === "Some",
  blockhash: (value: string) => value,
  createKeyPairSignerFromBytes: vi.fn(async (bytes: Uint8Array) => ({
    address: bytes[0] === 10 ? h.gasTank : h.reserve
  })),
  createSolanaRpc: vi.fn(() => ({
    getSignatureStatuses: (signatures: string[]) => ({
      send: async () => ({
        value: signatures.map((signature) => {
          const finality = h.signatureFinality[signature] ?? "finalized";
          if (finality === "failed") {
            return { confirmationStatus: "finalized", err: { InstructionError: [0, "Custom"] } };
          }
          if (finality === "pending") {
            return { confirmationStatus: "confirmed", err: null };
          }
          return { confirmationStatus: "finalized", err: null };
        })
      })
    }),
    getLatestBlockhash: () => ({
      send: async () => ({ value: { blockhash: "recent-blockhash", lastValidBlockHeight: 500n } })
    }),
    getBalance: () => ({
      send: async () => {
        h.gasTankBalanceCalls++;
        if (h.gasTankBalanceError) throw h.gasTankBalanceError;
        if (h.gasTankBalanceFailsOnCall === h.gasTankBalanceCalls) {
          throw new Error("RPC unavailable after reserve setup.");
        }
        return { value: h.gasTankBalanceLamports };
      }
    }),
    getMinimumBalanceForRentExemption: (space: bigint) => ({
      send: async () => space === 1024n ? 5_000_000n : 3_000_000n
    }),
    sendTransaction: () => ({
      send: async () => {
        if (h.sendTransactionError) throw h.sendTransactionError;
        const step = getPlanStep(h.currentPlan);
        h.submittedSteps.push(step);
        if (step === "account_setup") {
          h.setupCalls++;
          h.accountReady = true;
        }
        if (step === "program_configure") {
          h.configCalls++;
          h.reserveConfigured = true;
        }
        h.transactionPublicBalanceBefore = h.publicBalanceBaseUnits;
        h.lastTransactionType = step;
        if (h.signatureFinality["1".repeat(64)] !== "failed") {
          if (step === "preapply_apply") {
            const pending = h.pendingBalanceBaseUnits;
            h.pendingBalanceBaseUnits = 0n;
            h.availableBalanceBaseUnits += pending;
          }
          if (step === "deposit") {
            h.publicBalanceBaseUnits -= h.transactionAmount;
            h.pendingBalanceBaseUnits += h.transactionAmount;
          }
          if (step === "apply") {
            h.pendingBalanceBaseUnits = 0n;
            h.availableBalanceBaseUnits += h.transactionAmount;
          }
        }
        return "1".repeat(64);
      }
    }),
    getAccountInfo: (pubkey: string) => ({
      send: async () => {
        if (pubkey === h.workspace && h.workspaceInitialized) {
          return {
            value: {
              owner: h.programId,
              executable: false,
              data: workspaceAccount()
            }
          };
        }
        if (pubkey === h.reserveState && h.reserveConfigured) {
          return {
            value: {
              owner: h.programId,
              executable: false,
              data: reserveStateAccount()
            }
          };
        }
        return { value: null };
      }
    })
  })),
  createTransactionMessage: () => ({}),
  appendTransactionMessageInstruction: (instruction: any, message: any) => ({
    ...message,
    instructions: [...(message.instructions ?? []), instruction]
  }),
  createTransactionPlanner: (options: any) => async (plan: any) => {
    h.currentPlan = plan;
    const instructions: any[] = [];
    const visit = (value: any): void => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return;
      if (value.instruction) instructions.push(value.instruction);
      else if (value.programAddress && value.data instanceof Uint8Array) instructions.push(value);
      if (Array.isArray(value.plans)) value.plans.forEach(visit);
    };
    visit(plan);
    const initialMessage = options.createTransactionMessage();
    const messageWithLifetime = await options.onTransactionMessageUpdated(initialMessage);
    return {
      ...messageWithLifetime,
      instructions
    };
  },
  createTransactionPlanExecutorWithConcurrentLeaves: (options: any) => async (plan: any) => {
    await options.executeTransactionMessage({}, plan);
  },
  partiallySignTransactionMessageWithSigners: async (message: any) => {
    h.registeredInstructionSigners.push(
      message.instructions.map((instruction: any) =>
        (instruction.accounts ?? [])
          .filter((account: any) => account.signer)
          .map((account: any) => account.signer.address)
      ).flat()
    );
    return message;
  },
  addSignersToTransactionMessage: (signers: any[], message: any) => {
    h.registeredSignerAddresses.push(signers.map((signer) => signer.address));
    const signersByAddress = new Map(signers.map((signer) => [signer.address, signer]));
    return {
      ...message,
      feePayer: typeof message.feePayer === "object"
        ? message.feePayer
        : signersByAddress.get(message.feePayer?.address) ?? message.feePayer,
      registeredSigners: signers,
      instructions: message.instructions.map((instruction: any) => ({
        ...instruction,
        accounts: instruction.accounts?.map((account: any) =>
          [2, 3].includes(account.role) && signersByAddress.has(account.address)
            ? { ...account, signer: signersByAddress.get(account.address) }
            : account
        )
      }))
    };
  },
  getBase64EncodedWireTransaction: () =>
    Buffer.from([1, ...new Array(64).fill(0)]).toString("base64"),
  setTransactionMessageFeePayerSigner: (signer: any, message: any) => {
    h.feePayerAddresses.push(signer.address);
    return { ...message, feePayer: signer };
  },
  setTransactionMessageLifetimeUsingBlockhash: (_lifetime: any, message: any) => message,
  singleInstructionPlan: (instruction: any) => {
    h.configureAccounts = instruction.accounts;
    return { kind: "single", instruction };
  },
  getAddressEncoder: () => ({ encode: (value: string) => encode(value) }),
  getProgramDerivedAddress: async ({ seeds }: { seeds: Uint8Array[] }) => {
    const first = new TextDecoder().decode(seeds[0]);
    if (first === "workspace") return [h.workspace, 255];
    if (first === "reserve") return [h.reserveState, 255];
    throw new Error("Unexpected reserve PDA seed.");
  },
  fetchEncodedAccount: async (_rpc: unknown, tokenAddress: string) => {
    if (tokenAddress === h.reserveToken && h.accountReady) {
      return { exists: true, programAddress: h.accountOwner || h.tokenProgram };
    }
    return { exists: false, owner: h.tokenProgram };
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
  fetchToken: vi.fn(async () => ({
    data: {
      owner: h.reserve,
      mint: h.mint,
      amount: h.publicBalanceBaseUnits,
      extensions: [{
        __kind: "ConfidentialTransferAccount",
        approved: true,
        allowConfidentialCredits: true
      }]
    }
  })),
  findAssociatedTokenPda: vi.fn(async () => [h.reserveToken, 255]),
  getConfidentialDepositInstruction: vi.fn((input: any) => {
    h.transactionAmount = input.amount;
    return {
      programAddress: h.tokenProgram,
      accounts: [
        { address: input.token, role: 1 },
        { address: input.authority.address, role: 2 }
      ],
      data: new Uint8Array([
        201,
        ...new Array(8).fill(0).map((_, index) =>
          Number((input.amount >> BigInt(index * 8)) & 0xffn)
        )
      ])
    };
  })
}));

vi.mock("@solana-program/token-2022/confidential", () => ({
  deriveConfidentialKeys: vi.fn(async () => ({
    elgamalKeypair: { secretKey: new Uint8Array(32).fill(7) },
    aeKey: new Uint8Array(32).fill(8)
  })),
  fetchConfidentialTransferBalance: vi.fn(async () => ({
    availableBalance: h.availableBalanceBaseUnits,
    pendingBalance: h.pendingBalanceBaseUnits
  })),
  getCreateConfidentialTransferAccountInstructionPlan: vi.fn(async (input: any) => {
    h.setupArgs = { payer: input.payer.address, owner: input.owner.address };
    return {
      kind: "single",
      instruction: {
        programAddress: h.tokenProgram,
        accounts: [
          { address: input.payer.address, role: 3 },
          { address: input.owner.address, role: 3 }
        ],
        data: new Uint8Array([200])
      }
    };
  }),
  getApplyConfidentialPendingBalanceInstructionFromToken: vi.fn((input: any) => ({
    programAddress: h.tokenProgram,
    accounts: [
      { address: input.token, role: 1 },
      { address: input.authority.address, role: 2 }
    ],
    data: new Uint8Array([202])
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
  getWorkspacePayrollProgramAuthority: vi.fn(async () => ({ authorityAddress: h.authority })),
  getWorkspaceGasTank: vi.fn(async () => h.gasTankExists ? ({ address: h.gasTank }) : null),
  getWorkspaceReserve: vi.fn(async () => ({
    address: h.reserve,
    confidentialAccountSetupSignature: null,
    programReserveSetupSignature: null
  })),
  beginWorkspaceReserveFundingOperation: vi.fn(async (_db: unknown, input: any) => {
    if (!h.currentFeeReservationOperationData) {
      h.currentFeeReservationOperationData = {
        ...input.operationData,
        stage: input.initialStage ?? "wrap_verified"
      };
      h.transactionAmount = BigInt(String(input.operationData.amountBaseUnits));
    }
    return {
      status: "existing",
      operation: {
        id: "reserve-funding-operation",
        status: "preparing",
        feeLamports: "0",
        operationData: h.currentFeeReservationOperationData
      }
    };
  }),
  getReserveFundingFeeReservationKeys: vi.fn((input: any) => {
    const current = h.currentFeeReservationOperationData ?? {};
    const keys: string[] = [];
    const add = (phase: string, attempt: unknown, retry: boolean) => {
      const number = typeof attempt === "number" ? attempt : 0;
      keys.push(phase + ":" + String(retry ? number + 1 : Math.max(number, 1)));
    };
    switch (input.stage) {
      case "wrap_verified":
        if (input.pendingBalance > 0n) add("preapply", input.preapplyAttempt, true);
        add("deposit", input.depositAttempt, true);
        add("apply", input.applyAttempt, true);
        break;
      case "preapply_submitting":
        add("preapply", input.preapplyAttempt, false);
        add("deposit", input.depositAttempt, true);
        add("apply", input.applyAttempt, true);
        break;
      case "deposit_failed":
        add("deposit", input.depositAttempt, true);
        add("apply", input.applyAttempt, true);
        break;
      default:
        return input.pendingBalance > 0n
          ? ["preapply:1", "deposit:1", "apply:1"]
          : ["deposit:1", "apply:1"];
    }
    const used = Array.isArray(current.feeReservationKeys)
      ? current.feeReservationKeys as string[]
      : [];
    return keys.filter((key) => !used.includes(key));
  }),
  reserveWorkspaceReserveFundingFeeBudget: vi.fn(async (_db: unknown, input: unknown) => {
    h.feeReservationCalls.push(input);
    if (h.feeReservationResult === "reserved" || h.feeReservationResult === "duplicate") {
      const payload = input as { reservationKeys: string[] };
      const current = h.currentFeeReservationOperationData ?? {};
      const currentKeys = Array.isArray(current.feeReservationKeys)
        ? current.feeReservationKeys as string[]
        : [];
      const newKeys = payload.reservationKeys.filter((key) => !currentKeys.includes(key));
      const currentReserved = BigInt(String(current.reservedFeeBudgetLamports ?? "0"));
      h.currentFeeReservationOperationData = {
        ...current,
        wrapSignature: current.wrapSignature ?? "s".repeat(88),
        walletAddress: current.walletAddress ?? h.authority,
        feeBudgetReserved: true,
        actualFeeLamports: String(current.actualFeeLamports ?? "0"),
        reservedFeeBudgetLamports: (currentReserved + BigInt(newKeys.length) * 100_000n).toString(),
        feePerTransactionLamports: "100000",
        feeReservationKeys: [...currentKeys, ...newKeys],
        feeReservationSettledKeys: Array.isArray(current.feeReservationSettledKeys)
          ? current.feeReservationSettledKeys
          : [],
        feeBudgetSettledCount: Number(current.feeBudgetSettledCount ?? 0)
      };
    }
    return h.feeReservationResult;
  }),
  getWorkspaceGasTankOperation: vi.fn(async () => h.currentFeeReservationOperationData
    ? ({
        id: "reserve-funding-operation",
        status: "preparing",
        operationData: h.currentFeeReservationOperationData
      })
    : null),
  advanceWorkspaceReserveFundingOperation: vi.fn(async (_db: unknown, input: any) => {
    const current = h.currentFeeReservationOperationData ?? {};
    if (current.stage !== input.expectedStage) {
      return current.stage === input.nextStage ? "duplicate" : "conflict";
    }
    const updated: Record<string, unknown> = {
      ...current,
      ...(input.operationData ?? {}),
      stage: input.nextStage
    };
    if (Array.isArray(current.feeReservationKeys)) {
      const actual = BigInt(String(current.actualFeeLamports ?? "0")) + BigInt(input.feeLamportsAdded ?? "0");
      const reserved = BigInt(String(current.reservedFeeBudgetLamports ?? "0")) -
        BigInt(input.feeReservationConsumedLamports ?? "0");
      const settled = Array.isArray(current.feeReservationSettledKeys)
        ? [...current.feeReservationSettledKeys as string[]]
        : [];
      if (typeof input.feeReservationKey === "string" && !settled.includes(input.feeReservationKey)) {
        settled.push(input.feeReservationKey);
      }
      const remaining = input.nextStage === "finalized" ? 0n : (reserved > 0n ? reserved : 0n);
      updated.actualFeeLamports = actual.toString();
      updated.reservedFeeBudgetLamports = remaining.toString();
      updated.feeBudgetReserved = remaining > 0n;
      updated.feeReservationSettledKeys = settled;
      updated.feeBudgetSettledCount = settled.length;
    }
    h.currentFeeReservationOperationData = updated;
    return "updated";
  }),
  attachWorkspaceReserveSetupSignature: vi.fn(async (_db: unknown, input: { workspaceId: string; phase: string; signature: string }) => {
    h.attachCalls.push(input);
    return "attached";
  }),
  clearWorkspaceReserveSetupSignature: vi.fn(async (_db: unknown, input: { workspaceId: string; phase: string; signature: string }) => {
    h.clearCalls.push(input);
    return true;
  })
}));

vi.mock("../config", () => ({
  loadPayloreConfig: () => ({
    PAYLORE_WRAPPED_USDC_MINT: h.mint,
    PAYLORE_PAYROLL_PROGRAM_ID: h.programId,
    PAYLORE_RPC_PRIMARY_PROVIDER: "direct",
    PAYLORE_RPC_PRIMARY_URL: "https://api.devnet.solana.com"
  })
}));

vi.mock("../reserve", () => ({
  withWorkspaceReserveKey: async (_db: unknown, _workspaceId: string, run: (bytes: Uint8Array) => Promise<unknown>) =>
    run(new Uint8Array(64).fill(9))
}));
vi.mock("../gas-tank", () => ({
  withWorkspaceGasTankKey: async (_db: unknown, _workspaceId: string, run: (bytes: Uint8Array) => Promise<unknown>) =>
    run(new Uint8Array(64).fill(10))
}));
vi.mock("./rpc", () => ({
  readSolanaRpc: vi.fn(async (method: string, params: unknown[]) => {
    if (method !== "getTransaction") throw new Error("Unexpected Reserve funding RPC method.");
    const data = h.currentFeeReservationOperationData ?? {};
    const stage = String(data.stage ?? "");
    const phase = stage.startsWith("preapply")
      ? "preapply"
      : stage.startsWith("deposit")
        ? "deposit"
        : "apply";
    const instruction = data[phase + "Instruction"] as {
      programAddress: string;
      dataBase64: string;
      accountAddresses: string[];
    } | undefined;
    const marker = data[phase + "Marker"];
    if (!instruction || typeof marker !== "string") {
      throw new Error("Reserve funding stage is missing its persisted instruction marker.");
    }
    const signature = String(params[0]);
    const failed = h.signatureFinality[signature] === "failed";
    const before = h.transactionPublicBalanceBefore;
    const after = h.publicBalanceBaseUnits;
    return {
      slot: 123,
      meta: {
        err: failed ? { InstructionError: [0, "Custom"] } : null,
        fee: 5_000,
        preTokenBalances: [{
          accountIndex: 1,
          mint: h.mint,
          owner: h.reserve,
          programId: h.tokenProgram,
          uiTokenAmount: { amount: before.toString(), decimals: 6 }
        }],
        postTokenBalances: [{
          accountIndex: 1,
          mint: h.mint,
          owner: h.reserve,
          programId: h.tokenProgram,
          uiTokenAmount: { amount: after.toString(), decimals: 6 }
        }]
      },
      transaction: {
        signatures: [signature],
        message: {
          header: { numRequiredSignatures: 1 },
          accountKeys: [h.reserve, h.reserveToken],
          instructions: [
            {
              programId: instruction.programAddress,
              data: base58(Buffer.from(instruction.dataBase64, "base64")),
              accounts: instruction.accountAddresses
            },
            {
              programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
              data: base58(Buffer.from(marker, "utf8")),
              accounts: []
            }
          ]
        }
      }
    };
  })
}));

import { attachWorkspaceReserveSetupSignature } from "@paylore/database";

describe("ordinary-USDC Reserve funding Gas Tank preflight", () => {
  it("requires a live balance and the stored Gas Tank signer before the wrap wallet prompt", async () => {
    await expect(assertWorkspaceReserveFundingGasTankReady(
      {} as any, "workspace-a"
    )).resolves.toBeUndefined();
    expect(h.gasTankBalanceCalls).toBe(1);
  });

  it("blocks before wallet approval when the Gas Tank has no SOL reserve for the confidential transactions", async () => {
    h.gasTankBalanceLamports = 1n;

    await expect(assertWorkspaceReserveFundingGasTankReady(
      {} as any, "workspace-a"
    )).rejects.toMatchObject({
      code: "reserve_gas_tank_insufficient_funds",
      statusCode: 409
    });
  });

  it("fails closed when the Gas Tank balance cannot be read", async () => {
    h.gasTankBalanceError = new Error("RPC unavailable");

    await expect(assertWorkspaceReserveFundingGasTankReady(
      {} as any, "workspace-a"
    )).rejects.toMatchObject({
      code: "reserve_gas_tank_balance_unavailable",
      statusCode: 503
    });
  });

  it("requires Gas Tank signing-key custody before inviting the administrator to wrap USDC", async () => {
    h.gasTankExists = false;

    await expect(assertWorkspaceReserveFundingGasTankReady(
      {} as any, "workspace-a"
    )).rejects.toMatchObject({
      code: "reserve_gas_tank_not_initialized",
      statusCode: 409
    });
    expect(h.gasTankBalanceCalls).toBe(0);
  });
});

describe("ordinary-USDC Reserve confidential-funding Gas Tank budget", () => {
  it("reserves deposit and apply fees before any confidential transaction can be sent", async () => {
    h.reserveConfigured = true;
    h.publicBalanceBaseUnits = 5_000_000n;
    h.feeReservationResult = "insufficient_balance";

    await expect(completeWorkspaceReserveConfidentialFunding({
      db: {} as any,
      workspaceId: "workspace-a",
      fallbackAuthorityAddress: h.authority,
      amountBaseUnits: "1000000",
      wrapSignature: "s".repeat(88)
    })).rejects.toMatchObject({
      code: "reserve_gas_tank_insufficient_funds",
      statusCode: 409
    });

    expect(h.feeReservationCalls).toHaveLength(1);
    expect(h.feeReservationCalls[0]).toMatchObject({
      workspaceId: "workspace-a",
      reservationKeys: ["deposit:1", "apply:1"],
      feePerTransactionLamports: "100000",
      availableBalanceLamports: "1000000000"
    });
    expect(h.submittedSteps).toEqual([]);
    expect(h.feePayerAddresses).toEqual([]);
  });

  it("includes the earlier pending-balance apply phase in the same atomic fee reservation", async () => {
    h.reserveConfigured = true;
    h.publicBalanceBaseUnits = 5_000_000n;
    h.pendingBalanceBaseUnits = 250_000n;
    h.feeReservationResult = "insufficient_balance";

    await expect(completeWorkspaceReserveConfidentialFunding({
      db: {} as any,
      workspaceId: "workspace-a",
      fallbackAuthorityAddress: h.authority,
      amountBaseUnits: "1000000",
      wrapSignature: "s".repeat(88)
    })).rejects.toMatchObject({
      code: "reserve_gas_tank_insufficient_funds",
      statusCode: 409
    });

    expect(h.feeReservationCalls[0]).toMatchObject({
      reservationKeys: ["preapply:1", "deposit:1", "apply:1"]
    });
    expect(h.submittedSteps).toEqual([]);
    expect(h.feePayerAddresses).toEqual([]);
  });

  it("stops before confidential submission when the daily Gas Tank sponsorship limit is reached", async () => {
    h.reserveConfigured = true;
    h.publicBalanceBaseUnits = 5_000_000n;
    h.feeReservationResult = "daily_limit";

    await expect(completeWorkspaceReserveConfidentialFunding({
      db: {} as any,
      workspaceId: "workspace-a",
      fallbackAuthorityAddress: h.authority,
      amountBaseUnits: "1000000",
      wrapSignature: "s".repeat(88)
    })).rejects.toMatchObject({
      code: "reserve_gas_tank_daily_sponsorship_limit",
      statusCode: 429
    });

    expect(h.submittedSteps).toEqual([]);
    expect(h.feePayerAddresses).toEqual([]);
  });

  it("reconciles the committed fee reservation before checking the Reserve's available public balance", async () => {
    h.reserveConfigured = true;
    h.publicBalanceBaseUnits = 0n;
    h.feeReservationResult = "reserved";

    await expect(completeWorkspaceReserveConfidentialFunding({
      db: {} as any,
      workspaceId: "workspace-a",
      fallbackAuthorityAddress: h.authority,
      amountBaseUnits: "1000000",
      wrapSignature: "s".repeat(88)
    })).rejects.toMatchObject({
      code: "reserve_confidential_funding_public_balance_insufficient",
      statusCode: 409
    });

    expect(h.feeReservationCalls).toHaveLength(1);
    expect(h.submittedSteps).toEqual([]);
    expect(h.feePayerAddresses).toEqual([]);
  });

  it("executes and verifies the complete confidential deposit and apply sequence under the Gas Tank fee payer", async () => {
    h.reserveConfigured = true;
    h.publicBalanceBaseUnits = 5_000_000n;
    h.availableBalanceBaseUnits = 250_000n;

    const result = await completeWorkspaceReserveConfidentialFunding({
      db: {} as any,
      workspaceId: "workspace-a",
      fallbackAuthorityAddress: h.authority,
      amountBaseUnits: "1000000",
      wrapSignature: "s".repeat(88)
    });

    expect(result).toMatchObject({
      status: "confidential_balance_verified",
      amountBaseUnits: "1000000",
      publicBalanceBaseUnits: "4000000",
      availableBalanceBaseUnits: "1250000"
    });
    expect(h.submittedSteps).toEqual(["deposit", "apply"]);
    expect(h.feePayerAddresses).toEqual([h.gasTank, h.gasTank]);
    expect(h.feeReservationCalls[0]).toMatchObject({
      reservationKeys: ["deposit:1", "apply:1"],
      feePerTransactionLamports: "100000"
    });
    expect(h.currentFeeReservationOperationData).toMatchObject({
      stage: "finalized",
      feeBudgetReserved: false,
      actualFeeLamports: "10000",
      reservedFeeBudgetLamports: "0",
      feeReservationSettledKeys: ["deposit:1", "apply:1"]
    });
  });

  it("applies an earlier pending confidential balance before depositing the new Reserve funding", async () => {
    h.reserveConfigured = true;
    h.publicBalanceBaseUnits = 5_000_000n;
    h.availableBalanceBaseUnits = 500_000n;
    h.pendingBalanceBaseUnits = 250_000n;

    const result = await completeWorkspaceReserveConfidentialFunding({
      db: {} as any,
      workspaceId: "workspace-a",
      fallbackAuthorityAddress: h.authority,
      amountBaseUnits: "1000000",
      wrapSignature: "s".repeat(88)
    });

    expect(result).toMatchObject({
      status: "confidential_balance_verified",
      publicBalanceBaseUnits: "4000000",
      availableBalanceBaseUnits: "1750000"
    });
    expect(h.submittedSteps).toEqual(["preapply_apply", "deposit", "apply"]);
    expect(h.feeReservationCalls[0]).toMatchObject({
      reservationKeys: ["preapply:1", "deposit:1", "apply:1"]
    });
    expect(h.currentFeeReservationOperationData).toMatchObject({
      stage: "finalized",
      actualFeeLamports: "15000",
      reservedFeeBudgetLamports: "0",
      feeReservationSettledKeys: ["preapply:1", "deposit:1", "apply:1"]
    });
  });

  it("retries a finalized failed deposit only after reserving a new fee attempt", async () => {
    h.reserveConfigured = true;
    h.publicBalanceBaseUnits = 5_000_000n;
    h.availableBalanceBaseUnits = 500_000n;
    h.signatureFinality["1".repeat(64)] = "failed";

    await expect(completeWorkspaceReserveConfidentialFunding({
      db: {} as any,
      workspaceId: "workspace-a",
      fallbackAuthorityAddress: h.authority,
      amountBaseUnits: "1000000",
      wrapSignature: "s".repeat(88)
    })).resolves.toMatchObject({
      status: "pending",
      stage: "deposit_failed"
    });
    expect(h.publicBalanceBaseUnits).toBe(5_000_000n);
    expect(h.pendingBalanceBaseUnits).toBe(0n);
    expect(h.currentFeeReservationOperationData).toMatchObject({
      stage: "deposit_failed",
      feeReservationSettledKeys: ["deposit:1"],
      reservedFeeBudgetLamports: "100000"
    });

    h.signatureFinality["1".repeat(64)] = "finalized";
    const result = await completeWorkspaceReserveConfidentialFunding({
      db: {} as any,
      workspaceId: "workspace-a",
      fallbackAuthorityAddress: h.authority,
      amountBaseUnits: "1000000",
      wrapSignature: "s".repeat(88)
    });

    expect(result).toMatchObject({
      status: "confidential_balance_verified",
      publicBalanceBaseUnits: "4000000",
      availableBalanceBaseUnits: "1500000"
    });
    expect(h.feeReservationCalls).toHaveLength(2);
    expect(h.feeReservationCalls[1]).toMatchObject({
      reservationKeys: ["deposit:2"]
    });
    expect(h.currentFeeReservationOperationData).toMatchObject({
      stage: "finalized",
      feeReservationSettledKeys: ["deposit:1", "deposit:2", "apply:1"],
      actualFeeLamports: "15000",
      reservedFeeBudgetLamports: "0"
    });
  });

  it("does not reserve or submit when the live Gas Tank balance cannot be read", async () => {
    h.reserveConfigured = true;
    h.publicBalanceBaseUnits = 5_000_000n;
    h.gasTankBalanceError = new Error("RPC unavailable");

    await expect(completeWorkspaceReserveConfidentialFunding({
      db: {} as any,
      workspaceId: "workspace-a",
      fallbackAuthorityAddress: h.authority,
      amountBaseUnits: "1000000",
      wrapSignature: "s".repeat(88)
    })).rejects.toMatchObject({
      code: "reserve_gas_tank_balance_unavailable",
      statusCode: 503
    });

    expect(h.feeReservationCalls).toHaveLength(0);
    expect(h.submittedSteps).toEqual([]);
  });
});

describe("workspace confidential reserve initialization", () => {
  it("configures a reserve only after the workspace PDA and confidential token account are verified", async () => {
    const result = await initializeWorkspaceConfidentialReserveAccount(
      {} as any, "workspace-a", h.authority
    );

    expect(result).toMatchObject({
      status: "program_configured",
      reserveAddress: h.reserve,
      tokenAccount: h.reserveToken,
      confidentialTransferReady: true,
      programReserveConfigured: true,
      availableBalanceBaseUnits: "0",
      pendingBalanceBaseUnits: "0"
    });
    expect(h.submittedSteps).toEqual(["program_configure"]);
    expect(h.configCalls).toBe(1);
    expect(h.setupCalls).toBe(0);
    expect(h.attachCalls).toEqual([{
      workspaceId: "workspace-a",
      phase: "program_configure",
      signature: "1".repeat(64)
    }]);
    expect(h.clearCalls).toEqual([{
      workspaceId: "workspace-a",
      phase: "program_configure",
      signature: "1".repeat(64)
    }]);
  });

  it("uses the Gas Tank for fees while the Reserve remains the token owner and authority", async () => {
    h.accountReady = false;

    const result = await initializeWorkspaceConfidentialReserveAccount(
      {} as any, "workspace-a", h.authority
    );

    expect(result.status).toBe("program_configured");
    expect(h.setupArgs).toEqual({ payer: h.gasTank, owner: h.reserve });
    expect(h.feePayerAddresses).toEqual([h.gasTank, h.gasTank]);
    expect(h.registeredSignerAddresses).toEqual([
      [h.gasTank, h.reserve],
      [h.gasTank, h.reserve]
    ]);
    expect(h.registeredInstructionSigners).toEqual([
      [h.gasTank, h.reserve],
      [h.gasTank, h.reserve]
    ]);
    expect(h.configureAccounts?.map((account) => account.address)).toEqual([
      h.authority, h.workspace, h.gasTank, h.reserveState,
      h.reserve, h.reserveToken, h.mint, "11111111111111111111111111111111"
    ]);
  });

  it("does not declare Reserve setup ready when the post-finality Gas Tank balance check fails", async () => {
    h.gasTankBalanceFailsOnCall = 3;

    await expect(initializeWorkspaceConfidentialReserveAccount(
      {} as any, "workspace-a", h.authority
    )).rejects.toMatchObject({
      code: "reserve_gas_tank_balance_unavailable",
      statusCode: 503
    });

    expect(h.submittedSteps).toEqual(["program_configure"]);
    expect(h.reserveConfigured).toBe(true);

    const retry = await initializeWorkspaceConfidentialReserveAccount(
      {} as any, "workspace-a", h.authority
    );
    expect(retry.status).toBe("program_configured");
    expect(h.submittedSteps).toEqual(["program_configure"]);
  });

  it("blocks reserve setup when the Gas Tank balance cannot be verified", async () => {
    h.accountReady = false;
    h.gasTankBalanceError = new Error("RPC unavailable");

    await expect(initializeWorkspaceConfidentialReserveAccount(
      {} as any, "workspace-a", h.authority
    )).rejects.toMatchObject({
      code: "reserve_gas_tank_balance_unavailable",
      statusCode: 503
    });

    expect(h.submittedSteps).toEqual([]);
    expect(h.attachCalls).toEqual([]);
  });

  it("blocks all reserve setup transactions when the Gas Tank cannot cover rent and fees", async () => {
    h.accountReady = false;
    h.gasTankBalanceLamports = 1n;

    await expect(initializeWorkspaceConfidentialReserveAccount(
      {} as any, "workspace-a", h.authority
    )).rejects.toMatchObject({
      code: "reserve_gas_tank_insufficient_funds",
      statusCode: 409
    });

    expect(h.submittedSteps).toEqual([]);
    expect(h.setupArgs).toBeNull();
  });

  it("maps a late Gas Tank debit failure to a funding message instead of a generic verification error", async () => {
    h.sendTransactionError = new Error(
      "Attempt to debit an account but found no record of a prior credit."
    );

    await expect(initializeWorkspaceConfidentialReserveAccount(
      {} as any, "workspace-a", h.authority
    )).rejects.toMatchObject({
      code: "reserve_gas_tank_insufficient_funds",
      statusCode: 409
    });

    expect(h.submittedSteps).toEqual([]);
    expect(h.attachCalls).toEqual([]);
  });

  it("requires Gas Tank key custody before submitting reserve setup transactions", async () => {
    h.gasTankExists = false;
    h.accountReady = false;

    await expect(initializeWorkspaceConfidentialReserveAccount(
      {} as any, "workspace-a", h.authority
    )).rejects.toMatchObject({
      code: "reserve_gas_tank_not_initialized",
      statusCode: 409
    });
    expect(h.submittedSteps).toEqual([]);
  });

  it("creates the confidential account before configuring the reserve when the token account is absent", async () => {
    h.accountReady = false;

    const result = await initializeWorkspaceConfidentialReserveAccount(
      {} as any, "workspace-a", h.authority
    );

    expect(result.status).toBe("program_configured");
    expect(h.submittedSteps).toEqual(["account_setup", "program_configure"]);
    expect(h.setupCalls).toBe(1);
    expect(h.configCalls).toBe(1);
    expect(h.attachCalls.map((item) => item.phase)).toEqual(["account_setup", "program_configure"]);
    expect(h.clearCalls.map((item) => item.phase)).toEqual(["account_setup", "program_configure"]);
  });

  it("does not configure the reserve when the Payroll Program workspace state is absent", async () => {
    h.workspaceInitialized = false;

    const result = await initializeWorkspaceConfidentialReserveAccount(
      {} as any, "workspace-a", h.authority
    );

    expect(result).toMatchObject({
      status: "workspace_program_not_initialized",
      confidentialTransferReady: true,
      programReserveConfigured: false
    });
    expect(h.configCalls).toBe(0);
    expect(h.submittedSteps).toEqual([]);
  });

  it("reconciles a finalized account-setup signature before submitting only the missing program-configuration phase", async () => {
    const result = await initializeWorkspaceConfidentialReserveAccount(
      {} as any,
      "workspace-a",
      h.authority,
      { signature: "prior-account-setup-signature", phase: "account_setup" }
    );

    expect(result).toMatchObject({
      status: "program_configured",
      confidentialTransferReady: true,
      programReserveConfigured: true
    });
    expect(h.submittedSteps).toEqual(["program_configure"]);
    expect(h.setupCalls).toBe(0);
    expect(h.configCalls).toBe(1);
    expect(h.clearCalls[0]).toEqual({
      workspaceId: "workspace-a",
      phase: "account_setup",
      signature: "prior-account-setup-signature"
    });
  });

  it("keeps a failed stored configuration attempt retryable without silently submitting a replacement", async () => {
    h.signatureFinality["failed-config-signature"] = "failed";

    const result = await initializeWorkspaceConfidentialReserveAccount(
      {} as any,
      "workspace-a",
      h.authority,
      { signature: "failed-config-signature", phase: "program_configure" }
    );

    expect(result).toMatchObject({
      status: "retry_ready",
      signature: "failed-config-signature",
      phase: "program_configure"
    });
    expect(h.clearCalls).toEqual([{
      workspaceId: "workspace-a",
      phase: "program_configure",
      signature: "failed-config-signature"
    }]);
    expect(h.submittedSteps).toEqual([]);
    expect(h.configCalls).toBe(0);
  });

  it("rejects a token account owned by a different program", async () => {
    h.accountOwner = "WrongTokenProgram111111111111111111111111";
    await expect(initializeWorkspaceConfidentialReserveAccount(
      {} as any, "workspace-a", h.authority
    )).rejects.toMatchObject({
      code: "reserve_token_account_program_mismatch",
      statusCode: 409
    });
    expect(h.configCalls).toBe(0);
  });

  it("returns real balances without creating transactions when reading state", async () => {
    const result = await getWorkspaceConfidentialReserveSnapshot(
      {} as any, "workspace-a", h.authority
    );
    expect(result).toMatchObject({
      status: "confidential_account_ready",
      tokenAccount: h.reserveToken,
      confidentialTransferReady: true,
      publicBalanceBaseUnits: "0",
      availableBalanceBaseUnits: "0",
      pendingBalanceBaseUnits: "0",
      programReserveConfigured: false
    });
    expect(h.submittedSteps).toEqual([]);
    expect(h.attachCalls).toEqual([]);
  });

  it("uses only the workspace reserve setup-signature repository to persist returned transaction signatures", async () => {
    expect(attachWorkspaceReserveSetupSignature).toBeTypeOf("function");
  });
  it.each([
    { state: "unfunded", publicBalance: 0n, availableBalance: 0n, pendingBalance: 0n },
    { state: "public_funds_available", publicBalance: 1250000n, availableBalance: 0n, pendingBalance: 0n },
    { state: "pending_confidential_balance", publicBalance: 0n, availableBalance: 0n, pendingBalance: 25n },
    { state: "confidential_funds_available", publicBalance: 0n, availableBalance: 25n, pendingBalance: 0n }
  ] as const)("reports $state from the finalized reserve snapshot", async ({ state, publicBalance, availableBalance, pendingBalance }) => {
    h.publicBalanceBaseUnits = publicBalance;
    h.availableBalanceBaseUnits = availableBalance;
    h.pendingBalanceBaseUnits = pendingBalance;
    const result = await getWorkspaceConfidentialReserveSnapshot({} as any, "workspace-a", h.authority);
    expect(result).toMatchObject({
      status: "confidential_account_ready",
      publicBalanceBaseUnits: publicBalance.toString(),
      availableBalanceBaseUnits: availableBalance.toString(),
      pendingBalanceBaseUnits: pendingBalance.toString(),
      fundingState: state
    });
  });

});
