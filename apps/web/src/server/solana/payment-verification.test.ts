import { beforeEach, describe, expect, it, vi } from "vitest";

const mockState = vi.hoisted(() => ({
  recipient: "subscription-recipient",
  mint: "usdc-mint",
  transaction: null as unknown
}));

vi.mock("server-only", () => ({}));
vi.mock("../config", () => ({
  loadPayloreConfig: () => ({
    PAYLORE_SUBSCRIPTION_RECIPIENT: mockState.recipient,
    PAYLORE_SUBSCRIPTION_USDC_MINT: mockState.mint
  })
}));
vi.mock("../security", () => ({
  isValidSolanaAddress: (value: string) => typeof value === "string" && value.length > 0
}));
vi.mock("./rpc", () => ({
  readSolanaRpc: vi.fn(async () => mockState.transaction)
}));

import { readSolanaRpc } from "./rpc";
import { verifySubscriptionPayment } from "./payment-verification";

const SIGNATURE = "5".repeat(64);
const PAYER = "payer-wallet";
const SOURCE = "payer-usdc-account";
const DESTINATION = "recipient-usdc-account";
const RECIPIENT = "subscription-recipient";
const MINT = "usdc-mint";
const MEMO = "Paylore activation attempt 55a0 | workspace workspace-a";

type TransactionOverrides = {
  signature?: string;
  amount?: string;
  mint?: string;
  payerSigner?: boolean;
  recipientOwner?: string;
  error?: unknown;
  memo?: string;
  includeMemo?: boolean;
};

function transaction(overrides: TransactionOverrides = {}) {
  return {
    transaction: {
      signatures: [overrides.signature ?? SIGNATURE],
      message: {
        accountKeys: [
          { pubkey: SOURCE, signer: false },
          { pubkey: DESTINATION, signer: false },
          { pubkey: PAYER, signer: overrides.payerSigner ?? true }
        ],
        instructions: [
          {
            program: "spl-token",
            parsed: {
              type: "transferChecked",
              info: {
                source: SOURCE,
                destination: DESTINATION,
                mint: overrides.mint ?? MINT,
                tokenAmount: { amount: overrides.amount ?? "49000000", decimals: 6 }
              }
            }
          },
          ...(overrides.includeMemo === false ? [] : [{
            program: "spl-memo",
            parsed: overrides.memo ?? MEMO
          }])
        ]
      }
    },
    meta: {
      err: overrides.error ?? null,
      preTokenBalances: [{ accountIndex: 0, mint: MINT, owner: PAYER }],
      postTokenBalances: [{
        accountIndex: 1,
        mint: MINT,
        owner: overrides.recipientOwner ?? RECIPIENT
      }]
    }
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockState.recipient = RECIPIENT;
  mockState.mint = MINT;
  mockState.transaction = transaction();
});

describe("verified subscription payment", () => {
  it("accepts an exact finalized payment signed by the authenticated payer and bound to the prepared memo", async () => {
    await expect(verifySubscriptionPayment(SIGNATURE, PAYER, MEMO)).resolves.toEqual({
      signature: SIGNATURE,
      payerAddress: PAYER,
      recipient: RECIPIENT,
      mint: MINT,
      amountBaseUnits: "49000000"
    });
    expect(readSolanaRpc).toHaveBeenCalledWith("getTransaction", [
      SIGNATURE,
      { commitment: "finalized", encoding: "jsonParsed", maxSupportedTransactionVersion: 0 }
    ]);
  });

  it("rejects a response whose transaction signature is not the requested signature", async () => {
    mockState.transaction = transaction({ signature: "6".repeat(64) });
    await expect(verifySubscriptionPayment(SIGNATURE, PAYER)).rejects.toMatchObject({ reason: "failed" });
  });

  it("requires the exact unique payment-attempt memo when a prepared attempt is reconciled", async () => {
    mockState.transaction = transaction({ memo: "Paylore activation attempt other | workspace workspace-a" });
    await expect(verifySubscriptionPayment(SIGNATURE, PAYER, MEMO)).rejects.toMatchObject({ reason: "wrong_payment" });
    mockState.transaction = transaction({ includeMemo: false });
    await expect(verifySubscriptionPayment(SIGNATURE, PAYER, MEMO)).rejects.toMatchObject({ reason: "wrong_payment" });
  });

  it.each([
    ["amount", { amount: "48999999" }],
    ["mint", { mint: "wrong-mint" }],
    ["recipient owner", { recipientOwner: "attacker-wallet" }],
    ["payer signature", { payerSigner: false }]
  ] as const)("rejects a payment with an incorrect %s", async (_label, overrides) => {
    mockState.transaction = transaction(overrides);
    await expect(verifySubscriptionPayment(SIGNATURE, PAYER)).rejects.toMatchObject({ reason: "wrong_payment" });
  });

  it("does not treat a failed or missing finalized transaction as payment", async () => {
    mockState.transaction = transaction({ error: { InstructionError: [0, "Custom"] } });
    await expect(verifySubscriptionPayment(SIGNATURE, PAYER)).rejects.toMatchObject({ reason: "failed" });
    mockState.transaction = null;
    await expect(verifySubscriptionPayment(SIGNATURE, PAYER)).rejects.toMatchObject({ reason: "not_found" });
  });

  it("keeps configuration failures distinct from payment verification failures", async () => {
    mockState.recipient = "";
    await expect(verifySubscriptionPayment(SIGNATURE, PAYER)).rejects.toMatchObject({ reason: "configuration" });
  });
});
