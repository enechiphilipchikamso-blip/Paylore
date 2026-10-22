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

import {
  prepareSponsoredInstructionTransaction,
  prepareSponsoredPayrollClaimTransaction
} from "./gas-tank-sponsorship";

const wireTransaction = Buffer.concat([
  Buffer.from([1]),
  Buffer.alloc(64, 7),
  Buffer.from([9, 8, 7])
]);
const wireBase64 = wireTransaction.toString("base64");
const instructions = [{
  programAddress: "payroll-program" as never,
  accounts: [],
  data: new Uint8Array([1, 2, 3])
}];

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
      if (method === "getLatestBlockhash") {
        return { value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 123 } };
      }
      if (method === "getFeeForMessage") return { value: 5_000 };
      if (method === "simulateTransaction") return { value: { err: null, unitsConsumed: 20_000 } };
      throw new Error("Unexpected RPC method");
    });
  });

  it("validates the plan, sets the Gas Tank as fee payer, signs, simulates and returns bounded public metadata", async () => {
    const validateInstructions = vi.fn();
    const privateKey = new Uint8Array(64).fill(8);
    const result = await prepareSponsoredInstructionTransaction({
      instructions: instructions as never,
      validateInstructions,
      gasTankAddress: "gas-tank-address",
      gasTankPrivateKey: privateKey,
      balanceLamports: "100000",
      dailyBookedFeesLamports: 0n,
      dailyOperationCount: 0
    });
    expect(validateInstructions).toHaveBeenCalledWith(instructions);
    expect(mocks.setTransactionMessageFeePayerSigner).toHaveBeenCalledWith(
      { address: "gas-tank-address" }, expect.anything()
    );
    expect(mocks.getSignatureFromTransaction).toHaveBeenCalledOnce();
    expect(mocks.readSolanaRpc).toHaveBeenCalledWith("getFeeForMessage", [
      Buffer.from([9, 8, 7]).toString("base64"),
      { commitment: "confirmed" }
    ]);
    expect(result).toMatchObject({
      transactionBase64: wireBase64,
      signature: "prepared-signature",
      feeLamports: "5000",
      gasTankAddress: "gas-tank-address",
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 123
    });
    expect(Object.keys(result).sort()).toEqual([
      "blockhash", "feeLamports", "gasTankAddress", "lastValidBlockHeight", "signature", "transactionBase64"
    ]);
    expect([...privateKey].every((byte) => byte === 8)).toBe(true);
  });

  it("rejects a malformed plan before using the Gas Tank key", async () => {
    const validateInstructions = vi.fn(() => {
      throw new Error("instruction plan denied");
    });
    await expect(prepareSponsoredInstructionTransaction({
      instructions: instructions as never,
      validateInstructions,
      gasTankAddress: "gas-tank-address",
      gasTankPrivateKey: new Uint8Array(64).fill(8),
      balanceLamports: "100000",
      dailyBookedFeesLamports: 0n,
      dailyOperationCount: 0
    })).rejects.toThrow("instruction plan denied");
    expect(mocks.createKeyPairSignerFromBytes).not.toHaveBeenCalled();
  });

  it("fails closed when the decrypted key does not match the configured Gas Tank address", async () => {
    mocks.createKeyPairSignerFromBytes.mockResolvedValue({ address: "other-address" });
    await expect(prepareSponsoredInstructionTransaction({
      instructions: instructions as never,
      validateInstructions: vi.fn(),
      gasTankAddress: "gas-tank-address",
      gasTankPrivateKey: new Uint8Array(64).fill(8),
      balanceLamports: "100000",
      dailyBookedFeesLamports: 0n,
      dailyOperationCount: 0
    })).rejects.toMatchObject({ code: "gas_tank_key_identity_mismatch" });
    expect(mocks.readSolanaRpc).not.toHaveBeenCalled();
  });

  it("does not simulate or return a transaction when the available fee budget is insufficient", async () => {
    await expect(prepareSponsoredInstructionTransaction({
      instructions: instructions as never,
      validateInstructions: vi.fn(),
      gasTankAddress: "gas-tank-address",
      gasTankPrivateKey: new Uint8Array(64).fill(8),
      balanceLamports: "100",
      dailyBookedFeesLamports: 0n,
      dailyOperationCount: 0
    })).rejects.toMatchObject({ code: "gas_tank_insufficient_balance" });
    expect(mocks.readSolanaRpc).not.toHaveBeenCalledWith("simulateTransaction", expect.anything());
  });

  it("fails closed if transaction simulation reports an error", async () => {
    mocks.readSolanaRpc.mockImplementation(async (method: string) => {
      if (method === "getLatestBlockhash") {
        return { value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 123 } };
      }
      if (method === "getFeeForMessage") return { value: 5_000 };
      if (method === "simulateTransaction") return { value: { err: { InstructionError: [0, "Custom"] } } };
      throw new Error("Unexpected RPC method");
    });
    await expect(prepareSponsoredInstructionTransaction({
      instructions: instructions as never,
      validateInstructions: vi.fn(),
      gasTankAddress: "gas-tank-address",
      gasTankPrivateKey: new Uint8Array(64).fill(8),
      balanceLamports: "100000",
      dailyBookedFeesLamports: 0n,
      dailyOperationCount: 0
    })).rejects.toMatchObject({ code: "sponsored_simulation_failed" });
  });
  it("reconstructs the approved payroll claim plan and returns only public signing metadata", async () => {
    const sourceKey = new Uint8Array(64).fill(8);
    mocks.readSolanaRpc.mockImplementation(async (method: string) => {
      if (method === "getMultipleAccounts") return { value: [null, null] };
      if (method === "getLatestBlockhash") {
        return { value: { blockhash: "11111111111111111111111111111111", lastValidBlockHeight: 123 } };
      }
      if (method === "getFeeForMessage") return { value: 5_000 };
      if (method === "simulateTransaction") return { value: { err: null, unitsConsumed: 20_000 } };
      throw new Error("Unexpected RPC method");
    });
    const result = await prepareSponsoredPayrollClaimTransaction({
      workspaceId: "workspace-a",
      authorityAddress: "manager-wallet",
      programId: "payroll-program",
      gasTankAddress: "gas-tank-address",
      gasTankPrivateKey: sourceKey,
      balanceLamports: "100000",
      allocationCommitment: "ab".repeat(32),
      claims: [{ claimId: "01".repeat(32), contributorAddress: "contributor-wallet" }],
      dailyBookedFeesLamports: 0n,
      dailyOperationCount: 0
    });
    expect(mocks.readSolanaRpc).toHaveBeenCalledWith("getMultipleAccounts", [
      ["workspace-pda", "claim-pda"],
      { commitment: "finalized", encoding: "base64" }
    ]);
    expect(mocks.setTransactionMessageFeePayerSigner).toHaveBeenCalledWith(
      { address: "gas-tank-address" }, expect.anything()
    );
    expect(result).toMatchObject({
      transactionBase64: wireBase64,
      signature: "prepared-signature",
      feeLamports: "5000",
      gasTankAddress: "gas-tank-address",
      claims: [{ claimId: "01".repeat(32), claimAddress: "claim-pda" }],
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 123
    });
    expect(Object.keys(result).sort()).toEqual([
      "blockhash", "claims", "feeLamports", "gasTankAddress", "lastValidBlockHeight", "signature", "transactionBase64"
    ]);
    expect([...sourceKey].every((byte) => byte === 8)).toBe(true);
  });

  it("fails closed when the finalized workspace PDA is owned by a different program", async () => {
    mocks.readSolanaRpc.mockImplementation(async (method: string) => {
      if (method === "getMultipleAccounts") return { value: [{ owner: "other-program" }, null] };
      throw new Error("Unexpected RPC method");
    });
    await expect(prepareSponsoredPayrollClaimTransaction({
      workspaceId: "workspace-a",
      authorityAddress: "manager-wallet",
      programId: "payroll-program",
      gasTankAddress: "gas-tank-address",
      gasTankPrivateKey: new Uint8Array(64).fill(8),
      balanceLamports: "100000",
      allocationCommitment: "ab".repeat(32),
      claims: [{ claimId: "01".repeat(32), contributorAddress: "contributor-wallet" }],
      dailyBookedFeesLamports: 0n,
      dailyOperationCount: 0
    })).rejects.toMatchObject({ code: "sponsored_workspace_pda_owner_mismatch" });
    expect(mocks.createKeyPairSignerFromBytes).not.toHaveBeenCalled();
    expect(mocks.readSolanaRpc).not.toHaveBeenCalledWith("getLatestBlockhash", expect.anything());
  });

  it("does not sponsor a claim when its PDA already exists on finalized state", async () => {
    mocks.readSolanaRpc.mockImplementation(async (method: string) => {
      if (method === "getMultipleAccounts") {
        return { value: [null, { owner: "payroll-program", data: "AA==" }] };
      }
      throw new Error("Unexpected RPC method");
    });
    await expect(prepareSponsoredPayrollClaimTransaction({
      workspaceId: "workspace-a",
      authorityAddress: "manager-wallet",
      programId: "payroll-program",
      gasTankAddress: "gas-tank-address",
      gasTankPrivateKey: new Uint8Array(64).fill(8),
      balanceLamports: "100000",
      allocationCommitment: "ab".repeat(32),
      claims: [{ claimId: "01".repeat(32), contributorAddress: "contributor-wallet" }],
      dailyBookedFeesLamports: 0n,
      dailyOperationCount: 0
    })).rejects.toMatchObject({ code: "sponsored_claim_already_exists" });
    expect(mocks.createKeyPairSignerFromBytes).not.toHaveBeenCalled();
    expect(mocks.readSolanaRpc).not.toHaveBeenCalledWith("getLatestBlockhash", expect.anything());
  });

});
