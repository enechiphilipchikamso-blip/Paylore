import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getWorkspaceConfidentialReserveSnapshot,
  initializeWorkspaceConfidentialReserveAccount,
  WorkspaceReserveInitializationError
} from "./workspace-reserve";

const h = vi.hoisted(() => ({
  tokenProgram: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
  authority: "11111111111111111111111111111111",
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
  clearCalls: [] as Array<{phase:string;signature:string}>
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
    clearCalls: []
  });
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
        h.submittedSteps.push(step);
        if (step === "account_setup") {
          h.setupCalls++;
          h.accountReady = true;
        }
        if (step === "program_configure") {
          h.configCalls++;
          h.reserveConfigured = true;
        }
        return h.setupSignature + "-" + h.submittedSteps.length;
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
  getAddressEncoder: () => ({ encode: (value: string) => encode(value) }),
  getProgramDerivedAddress: async ({ seeds }: { seeds: Uint8Array[] }) => {
    const first = new TextDecoder().decode(seeds[0]);
    if (first === "workspace") return [h.workspace, 255];
    if (first === "reserve") return [h.reserveState, 255];
    throw new Error("Unexpected reserve PDA seed.");
  },
  fetchEncodedAccount: async (_rpc: unknown, tokenAddress: string) => {
    if (tokenAddress === h.reserveToken && h.accountReady) {
      return { exists: true, owner: h.accountOwner || h.tokenProgram };
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
  findAssociatedTokenPda: vi.fn(async () => [h.reserveToken, 255])
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
  getCreateConfidentialTransferAccountInstructionPlan: vi.fn(async () => ({
    kind: "single",
    instruction: {
      programAddress: h.tokenProgram,
      accounts: [],
      data: new Uint8Array([200])
    }
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
  getWorkspaceReserve: vi.fn(async () => ({
    address: h.reserve,
    confidentialAccountSetupSignature: null,
    programReserveSetupSignature: null
  })),
  attachWorkspaceReserveSetupSignature: vi.fn(async (_db: unknown, input: { phase: string; signature: string }) => {
    h.attachCalls.push(input);
    return "attached";
  }),
  clearWorkspaceReserveSetupSignature: vi.fn(async (_db: unknown, input: { phase: string; signature: string }) => {
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

import { attachWorkspaceReserveSetupSignature } from "@paylore/database";

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
      phase: "program_configure",
      signature: "setup-signature-1"
    }]);
    expect(h.clearCalls).toEqual([{
      phase: "program_configure",
      signature: "setup-signature-1"
    }]);
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
