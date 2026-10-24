import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  address: vi.fn(),
  getAddressEncoder: vi.fn(),
  getProgramDerivedAddress: vi.fn(),
  createKeyPairSignerFromBytes: vi.fn(),
  blockhash: vi.fn(),
  appendTransactionMessageInstructions: vi.fn(),
  createTransactionMessage: vi.fn(),
  getBase64EncodedWireTransaction: vi.fn(),
  getSignatureFromTransaction: vi.fn(),
  partiallySignTransactionMessageWithSigners: vi.fn(),
  setTransactionMessageFeePayerSigner: vi.fn(),
  setTransactionMessageLifetimeUsingBlockhash: vi.fn(),
  readSolanaRpc: vi.fn()
}));

vi.mock("server-only", () => ({}));
vi.mock("./solana/rpc", () => ({ readSolanaRpc: mocks.readSolanaRpc }));
vi.mock("@solana/kit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@solana/kit")>();
  return {
    ...actual,
    address: mocks.address,
    getAddressEncoder: mocks.getAddressEncoder,
    getProgramDerivedAddress: mocks.getProgramDerivedAddress,
    blockhash: mocks.blockhash,
    appendTransactionMessageInstructions: mocks.appendTransactionMessageInstructions,
    createKeyPairSignerFromBytes: mocks.createKeyPairSignerFromBytes,
    createTransactionMessage: mocks.createTransactionMessage,
    getBase64EncodedWireTransaction: mocks.getBase64EncodedWireTransaction,
    getSignatureFromTransaction: mocks.getSignatureFromTransaction,
    partiallySignTransactionMessageWithSigners: mocks.partiallySignTransactionMessageWithSigners,
    setTransactionMessageFeePayerSigner: mocks.setTransactionMessageFeePayerSigner,
    setTransactionMessageLifetimeUsingBlockhash: mocks.setTransactionMessageLifetimeUsingBlockhash
  };
});

import { prepareSponsoredPayrollClaimTransaction } from "./gas-tank-sponsorship";

const wireTransaction = Buffer.concat([
  Buffer.from([1]),
  Buffer.alloc(64, 7),
  Buffer.from([9, 8, 7])
]);
const wireBase64 = wireTransaction.toString("base64");
const claimId = "01".repeat(32);
const allocationCommitment = "ab".repeat(32);
const privateKey = () => new Uint8Array(64).fill(8);

function prepare(overrides: Partial<Parameters<typeof prepareSponsoredPayrollClaimTransaction>[0]> = {}) {
  return prepareSponsoredPayrollClaimTransaction({
    workspaceId: "workspace-a",
    authorityAddress: "manager-wallet",
    programId: "payroll-program",
    gasTankAddress: "gas-tank-address",
    gasTankPrivateKey: privateKey(),
    balanceLamports: "100000",
    allocationCommitment,
    claims: [{ claimId, contributorAddress: "contributor-wallet", amountCommitment: "ab".repeat(32) }],
    dailyBookedFeesLamports: 0n,
    dailyOperationCount: 0,
    ...overrides
  });
}

describe("server-built Gas Tank sponsored transactions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.address.mockImplementation((value: string) => value);
    mocks.getAddressEncoder.mockReturnValue({
      encode: (value: string) => new TextEncoder().encode(value)
    });
    mocks.getProgramDerivedAddress.mockImplementation(async (input: { seeds: Uint8Array[] }) => [
      new TextDecoder().decode(input.seeds[0]) === "workspace" ? "workspace-pda" : "claim-pda"
    ]);
    mocks.createKeyPairSignerFromBytes.mockResolvedValue({ address: "gas-tank-address" });
    mocks.blockhash.mockImplementation((value: string) => value);
    mocks.createTransactionMessage.mockReturnValue({ version: 0 });
    mocks.setTransactionMessageFeePayerSigner.mockImplementation((signer: unknown, message: unknown) => ({
      ...(message as object), feePayer: signer
    }));
    mocks.setTransactionMessageLifetimeUsingBlockhash.mockImplementation((lifetime: unknown, message: unknown) => ({
      ...(message as object), lifetime
    }));
    mocks.appendTransactionMessageInstructions.mockImplementation((items: unknown, message: unknown) => ({
      ...(message as object), instructions: items
    }));
    mocks.partiallySignTransactionMessageWithSigners.mockResolvedValue({ transaction: "partially-signed" });
    mocks.getBase64EncodedWireTransaction.mockReturnValue(wireBase64);
    mocks.getSignatureFromTransaction.mockReturnValue("prepared-signature");
    mocks.readSolanaRpc.mockImplementation(async (method: string) => {
      if (method === "getMultipleAccounts") return { value: [null, null] };
      if (method === "getLatestBlockhash") {
        return { value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 123 } };
      }
      if (method === "getFeeForMessage") return { value: 5_000 };
      if (method === "simulateTransaction") return { value: { err: null, unitsConsumed: 20_000 } };
      throw new Error("Unexpected RPC method");
    });
  });

  it("reconstructs the approved payroll claim plan and returns only public signing metadata", async () => {
    const sourceKey = privateKey();
    const result = await prepare({ gasTankPrivateKey: sourceKey });

    expect(mocks.readSolanaRpc).toHaveBeenCalledWith("getMultipleAccounts", [
      ["workspace-pda", "claim-pda"],
      { commitment: "finalized", encoding: "base64" }
    ]);
    expect(mocks.setTransactionMessageFeePayerSigner).toHaveBeenCalledWith(
      { address: "gas-tank-address" }, expect.anything()
    );
    expect(mocks.readSolanaRpc).toHaveBeenCalledWith("getFeeForMessage", [
      Buffer.from([9, 8, 7]).toString("base64"),
      { commitment: "confirmed" }
    ]);
    expect(result).toMatchObject({
      transactionBase64: wireBase64,
      signature: "prepared-signature",
      feeLamports: "5000",
      gasTankAddress: "gas-tank-address",
      claims: [{ claimId, claimAddress: "claim-pda" }],
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 123
    });
    expect(Object.keys(result).sort()).toEqual([
      "blockhash", "claims", "feeLamports", "gasTankAddress", "lastValidBlockHeight", "signature", "transactionBase64"
    ]);
    expect([...sourceKey].every((byte) => byte === 8)).toBe(true);
  });

  it("fails closed when finalized account state cannot be read before sponsor signing", async () => {
    mocks.readSolanaRpc.mockImplementation(async (method: string) => {
      if (method === "getMultipleAccounts") return { value: [] };
      throw new Error("Unexpected RPC method");
    });
    await expect(prepare()).rejects.toMatchObject({ code: "sponsored_claim_state_unavailable" });
    expect(mocks.createKeyPairSignerFromBytes).not.toHaveBeenCalled();
    expect(mocks.readSolanaRpc).not.toHaveBeenCalledWith("getLatestBlockhash", expect.anything());
  });

  it("fails closed when the finalized workspace PDA is owned by a different program", async () => {
    mocks.readSolanaRpc.mockImplementation(async (method: string) => {
      if (method === "getMultipleAccounts") return { value: [{ owner: "other-program" }, null] };
      throw new Error("Unexpected RPC method");
    });
    await expect(prepare()).rejects.toMatchObject({ code: "sponsored_workspace_pda_owner_mismatch" });
    expect(mocks.createKeyPairSignerFromBytes).not.toHaveBeenCalled();
    expect(mocks.readSolanaRpc).not.toHaveBeenCalledWith("getLatestBlockhash", expect.anything());
  });

  it("does not sponsor a claim when its PDA already exists on finalized state", async () => {
    mocks.readSolanaRpc.mockImplementation(async (method: string) => {
      if (method === "getMultipleAccounts") return { value: [null, { owner: "payroll-program", data: "AA==" }] };
      throw new Error("Unexpected RPC method");
    });
    await expect(prepare()).rejects.toMatchObject({ code: "sponsored_claim_already_exists" });
    expect(mocks.createKeyPairSignerFromBytes).not.toHaveBeenCalled();
    expect(mocks.readSolanaRpc).not.toHaveBeenCalledWith("getLatestBlockhash", expect.anything());
  });

  it("checks that the decrypted Gas Tank key matches the configured address", async () => {
    mocks.createKeyPairSignerFromBytes.mockResolvedValue({ address: "another-address" });
    await expect(prepare()).rejects.toMatchObject({ code: "gas_tank_key_identity_mismatch" });
    expect(mocks.readSolanaRpc).not.toHaveBeenCalledWith("getFeeForMessage", expect.anything());
  });

  it("rejects a fee budget that cannot cover the measured transaction fee", async () => {
    await expect(prepare({ balanceLamports: "100" })).rejects.toMatchObject({ code: "gas_tank_insufficient_balance" });
    expect(mocks.readSolanaRpc).not.toHaveBeenCalledWith("simulateTransaction", expect.anything());
  });

  it("fails closed when simulation reports a transaction error", async () => {
    mocks.readSolanaRpc.mockImplementation(async (method: string) => {
      if (method === "getMultipleAccounts") return { value: [null, null] };
      if (method === "getLatestBlockhash") {
        return { value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 123 } };
      }
      if (method === "getFeeForMessage") return { value: 5_000 };
      if (method === "simulateTransaction") return { value: { err: { InstructionError: [0, "Custom"] } } };
      throw new Error("Unexpected RPC method");
    });
    await expect(prepare()).rejects.toMatchObject({ code: "sponsored_simulation_failed" });
  });

  it("rejects an unavailable network fee estimate without presenting a prepared transaction", async () => {
    mocks.readSolanaRpc.mockImplementation(async (method: string) => {
      if (method === "getMultipleAccounts") return { value: [null, null] };
      if (method === "getLatestBlockhash") {
        return { value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 123 } };
      }
      if (method === "getFeeForMessage") return { value: null };
      throw new Error("Unexpected RPC method");
    });
    await expect(prepare()).rejects.toMatchObject({ code: "sponsored_fee_unavailable" });
    expect(mocks.readSolanaRpc).not.toHaveBeenCalledWith("simulateTransaction", expect.anything());
  });
});
