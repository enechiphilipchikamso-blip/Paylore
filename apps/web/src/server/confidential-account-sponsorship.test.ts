import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const mocks = vi.hoisted(() => ({
  decodeTransaction: vi.fn(),
  decodeMessage: vi.fn(),
  encodeAddress: vi.fn(),
  verifySignature: vi.fn(),
  readSolanaRpc: vi.fn(),
  assertAllowedConfidentialAccountSetupMessage: vi.fn(),
  assertSponsoredCost: vi.fn(),
  assertSimulationSucceeded: vi.fn()
}));
vi.mock("@solana/kit", () => ({
  address: (value: string) => value,
  getAddressEncoder: () => ({ encode: mocks.encodeAddress }),
  getTransactionDecoder: () => ({ decode: mocks.decodeTransaction }),
  getCompiledTransactionMessageDecoder: () => ({ decode: mocks.decodeMessage }),
  verifySignature: mocks.verifySignature
}));
vi.mock("./solana/rpc", () => ({ readSolanaRpc: mocks.readSolanaRpc }));
vi.mock("./gas-tank-sponsorship-policy", () => ({
  GasTankSponsorshipPolicyError: class GasTankSponsorshipPolicyError extends Error {
    constructor(readonly code: string) { super(code); }
  },
  MAX_CONFIDENTIAL_ACCOUNT_SETUP_RENT_LAMPORTS: 10_000_000n,
  assertAllowedConfidentialAccountSetupMessage: mocks.assertAllowedConfidentialAccountSetupMessage,
  assertSponsoredCost: mocks.assertSponsoredCost,
  assertSimulationSucceeded: mocks.assertSimulationSucceeded
}));

import { inspectSponsoredConfidentialSetupTransaction } from "./confidential-account-sponsorship";

const transaction = {
  messageBytes: Uint8Array.of(1, 2, 3),
  signatures: {
    contributor: Uint8Array.of(4, 5, 6),
    "gas-tank": new Uint8Array(64)
  }
};
const message = {
  version: 0,
  staticAccounts: ["gas-tank", "contributor"],
  header: {
    numSignerAccounts: 2,
    numReadonlySignerAccounts: 1,
    numReadonlyNonSignerAccounts: 0
  },
  instructions: [{ programAddressIndex: 0, accountIndices: [], data: Uint8Array.of(1) }]
};
const input = {
  transactionBase64: "AQ==",
  ownerAddress: "contributor",
  mintAddress: "wrapped-mint",
  tokenAccountAddress: "contributor-token-account",
  token2022ProgramAddress: "token-2022",
  gasTankAddress: "gas-tank",
  balanceLamports: "50000000",
  dailyBookedFeesLamports: 0n,
  dailyOperationCount: 0
};

afterEach(() => vi.resetAllMocks());

describe("confidential account sponsorship transaction authorization", () => {
  beforeEach(() => {
    mocks.decodeTransaction.mockReturnValue(transaction);
    mocks.decodeMessage.mockReturnValue(message);
    mocks.encodeAddress.mockReturnValue(new Uint8Array(32));
    mocks.verifySignature.mockResolvedValue(true);
    mocks.readSolanaRpc.mockResolvedValue({ value: 5_000 });
    mocks.assertAllowedConfidentialAccountSetupMessage.mockReturnValue({
      reservedRentLamports: 10_000_000n
    });
    mocks.assertSponsoredCost.mockImplementation(() => undefined);
  });

  it("rejects malformed wire bytes before decoding or signing", async () => {
    await expect(inspectSponsoredConfidentialSetupTransaction({
      ...input,
      transactionBase64: "not base64!"
    })).rejects.toMatchObject({ code: "sponsored_transaction_encoding_invalid" });
    expect(mocks.decodeTransaction).not.toHaveBeenCalled();
    expect(mocks.readSolanaRpc).not.toHaveBeenCalled();
  });

  it("requires a contributor signature and rejects an invalid signature", async () => {
    mocks.decodeTransaction.mockReturnValue({
      ...transaction,
      signatures: { "gas-tank": new Uint8Array(64) }
    });
    await expect(inspectSponsoredConfidentialSetupTransaction(input))
      .rejects.toMatchObject({ code: "confidential_setup_owner_signature_required" });
    expect(mocks.verifySignature).not.toHaveBeenCalled();

    mocks.decodeTransaction.mockReturnValue(transaction);
    mocks.verifySignature.mockResolvedValue(false);
    await expect(inspectSponsoredConfidentialSetupTransaction(input))
      .rejects.toMatchObject({ code: "confidential_setup_owner_signature_invalid" });
    expect(mocks.readSolanaRpc).not.toHaveBeenCalled();
  });

  it("rejects a client-selected fee payer that is not the workspace Gas Tank", async () => {
    mocks.decodeMessage.mockReturnValue({ ...message, staticAccounts: ["attacker", "contributor"] });
    await expect(inspectSponsoredConfidentialSetupTransaction(input))
      .rejects.toMatchObject({ code: "confidential_setup_fee_payer_denied" });
    expect(mocks.readSolanaRpc).not.toHaveBeenCalled();
  });

  it("reserves the policy-approved rent and network fee for a contributor-authorized message", async () => {
    const result = await inspectSponsoredConfidentialSetupTransaction(input);
    expect(result).toMatchObject({
      feeLamports: 5_000n,
      reservedRentLamports: 10_000_000n,
      transactionBytes: 1
    });
    expect(mocks.assertAllowedConfidentialAccountSetupMessage).toHaveBeenCalledWith(expect.objectContaining({
      feePayerAddress: "gas-tank",
      ownerAddress: "contributor",
      mintAddress: "wrapped-mint",
      tokenAccountAddress: "contributor-token-account"
    }));
    expect(mocks.assertSponsoredCost).toHaveBeenCalledWith(expect.objectContaining({
      feeLamports: 5_000n,
      balanceLamports: 50_000_000n
    }));
  });
});
