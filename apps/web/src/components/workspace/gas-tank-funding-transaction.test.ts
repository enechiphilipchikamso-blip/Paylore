import { describe, expect, it } from "vitest";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash
} from "@solana/kit";
import {
  createGasTankFundingTransaction,
  GAS_TANK_FUNDING_CHANGED,
  isExpectedGasTankFundingMessage,
  signedGasTankFunding,
  solToLamports
} from "./gas-tank-funding-transaction";

const fundingInput = {
  payer: "SysvarRent111111111111111111111111111111111",
  destination: "11111111111111111111111111111112",
  lamports: "50000000",
  blockhash: "11111111111111111111111111111111",
  lastValidBlockHeight: 100
};
const expected = {
  payer: fundingInput.payer,
  destination: fundingInput.destination,
  lamports: fundingInput.lamports
};

const SYSTEM_PROGRAM = "11111111111111111111111111111111";
const COMPUTE_BUDGET = "ComputeBudget111111111111111111111111111111";
const TOKEN_2022 = "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb";

// Wire layout: [signature count][64-byte signatures][message].
function withPayerSignature(transaction: Uint8Array): Uint8Array {
  const signed = Uint8Array.from(transaction);
  signed.fill(7, 1, 65);
  return signed;
}

function transferData(lamports: string): Uint8Array {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, BigInt(lamports), true);
  return data;
}

type ExtraInstruction = {
  programAddress: string;
  accounts?: Array<{ address: string; role: AccountRole }>;
  data?: Uint8Array;
};

/** Builds a signed transaction the way a wallet might re-encode the reviewed transfer. */
function walletEncoded(options: {
  version?: "legacy" | 0;
  leading?: ExtraInstruction[];
  lamports?: string;
  destination?: string;
  blockhash?: string;
}): Uint8Array {
  const payer = address(fundingInput.payer);
  const destination = address(options.destination ?? fundingInput.destination);
  const transfer = {
    programAddress: address(SYSTEM_PROGRAM),
    accounts: [
      { address: payer, role: AccountRole.WRITABLE_SIGNER },
      { address: destination, role: AccountRole.WRITABLE }
    ],
    data: transferData(options.lamports ?? fundingInput.lamports)
  };
  const instructions = [
    ...(options.leading ?? []).map((item) => ({
      programAddress: address(item.programAddress),
      accounts: (item.accounts ?? []).map((account) => ({
        address: address(account.address),
        role: account.role
      })),
      data: item.data ?? new Uint8Array()
    })),
    transfer
  ];
  const message = appendTransactionMessageInstructions(
    instructions as never,
    setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash(options.blockhash ?? fundingInput.blockhash),
        lastValidBlockHeight: 100n
      },
      setTransactionMessageFeePayer(
        payer,
        createTransactionMessage({ version: options.version ?? 0 })
      )
    )
  );
  const wire = getBase64EncodedWireTransaction(compileTransaction(message));
  return withPayerSignature(
    Uint8Array.from(atob(wire), (character) => character.charCodeAt(0))
  );
}

const priorityFee: ExtraInstruction[] = [
  // SetComputeUnitLimit(200_000) then SetComputeUnitPrice(5_000 micro-lamports).
  { programAddress: COMPUTE_BUDGET, data: Uint8Array.from([2, 64, 13, 3, 0]) },
  {
    programAddress: COMPUTE_BUDGET,
    data: Uint8Array.from([3, 136, 19, 0, 0, 0, 0, 0, 0])
  }
];

describe("Gas Tank funding transaction", () => {
  it("converts SOL to lamports without floating-point rounding", () => {
    expect(solToLamports("1.000000001")).toBe("1000000001");
    expect(solToLamports("0.05")).toBe("50000000");
  });

  it.each(["", "0", "0.0000000001", "-1", "1e-3", "01"])(
    "rejects malformed or zero SOL input %s",
    (value) => {
      expect(() => solToLamports(value)).toThrow();
    }
  );

  it("builds a single wallet-signable Devnet transfer", () => {
    const transaction = createGasTankFundingTransaction({
      payer: "SysvarRent111111111111111111111111111111111",
      destination: "11111111111111111111111111111112",
      lamports: "50000000",
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 100
    });
    expect(transaction).toBeInstanceOf(Uint8Array);
    expect(transaction.length).toBeGreaterThan(20);
  });

  it("rejects amounts outside the System Program u64 range", () => {
    expect(() =>
      createGasTankFundingTransaction({
        payer: "SysvarRent111111111111111111111111111111111",
        destination: "11111111111111111111111111111112",
        lamports: "18446744073709551616",
        blockhash: "11111111111111111111111111111111",
        lastValidBlockHeight: 100
      })
    ).toThrow();
  });

  it("returns the payer signature for the exact reviewed transfer", () => {
    const reviewed = createGasTankFundingTransaction(fundingInput);
    const signed = withPayerSignature(reviewed);
    const result = signedGasTankFunding(signed, expected);
    expect(result.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
    expect(atob(result.transactionBase64).length).toBe(reviewed.length);
  });

  it("accepts a wallet that wraps the transfer with priority-fee instructions", () => {
    const signed = walletEncoded({ leading: priorityFee });
    const result = signedGasTankFunding(signed, expected);
    expect(result.signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{64,88}$/);
    // Paylore submits exactly what the wallet signed, never a rebuilt transaction.
    expect(atob(result.transactionBase64).length).toBe(signed.length);
  });

  it("accepts a wallet that re-serializes the transfer as a legacy message", () => {
    expect(() =>
      signedGasTankFunding(walletEncoded({ version: "legacy" }), expected)
    ).not.toThrow();
  });

  it("accepts a wallet that refreshes the blockhash", () => {
    expect(() =>
      signedGasTankFunding(
        walletEncoded({ blockhash: "SysvarC1ock11111111111111111111111111111111" }),
        expected
      )
    ).not.toThrow();
  });

  it("refuses an unsigned transfer", () => {
    const reviewed = createGasTankFundingTransaction(fundingInput);
    expect(() => signedGasTankFunding(reviewed, expected)).toThrow(
      "No funding was sent"
    );
  });

  it("refuses a transfer whose amount the wallet changed", () => {
    expect(() =>
      signedGasTankFunding(walletEncoded({ lamports: "60000000" }), expected)
    ).toThrow(GAS_TANK_FUNDING_CHANGED);
  });

  it("refuses a transfer the wallet redirected to another account", () => {
    expect(() =>
      signedGasTankFunding(
        walletEncoded({ destination: "SysvarC1ock11111111111111111111111111111111" }),
        expected
      )
    ).toThrow(GAS_TANK_FUNDING_CHANGED);
  });

  it("refuses payloads that are not a transaction or exceed the Solana size limit", () => {
    expect(() =>
      signedGasTankFunding(Uint8Array.from([1, 2, 3]), expected)
    ).toThrow(GAS_TANK_FUNDING_CHANGED);
    expect(() =>
      signedGasTankFunding(new Uint8Array(1_233), expected)
    ).toThrow(GAS_TANK_FUNDING_CHANGED);
  });
});

describe("isExpectedGasTankFundingMessage", () => {
  const messageOf = (transaction: Uint8Array) =>
    // Skip the signature count and the single 64-byte signature.
    transaction.slice(65);

  it("accepts the reviewed transfer and priority-fee wrapping", () => {
    expect(isExpectedGasTankFundingMessage(messageOf(walletEncoded({})), expected)).toBe(true);
    expect(
      isExpectedGasTankFundingMessage(messageOf(walletEncoded({ leading: priorityFee })), expected)
    ).toBe(true);
  });

  it("refuses an instruction from a program that is not allowlisted", () => {
    const bundled = walletEncoded({ leading: [{ programAddress: TOKEN_2022 }] });
    expect(isExpectedGasTankFundingMessage(messageOf(bundled), expected)).toBe(false);
  });

  it("refuses a Compute Budget instruction that carries accounts", () => {
    const bundled = walletEncoded({
      leading: [{
        programAddress: COMPUTE_BUDGET,
        accounts: [{ address: fundingInput.destination, role: AccountRole.WRITABLE }]
      }]
    });
    expect(isExpectedGasTankFundingMessage(messageOf(bundled), expected)).toBe(false);
  });

  it("refuses a second System Program transfer", () => {
    const bundled = walletEncoded({
      leading: [{
        programAddress: SYSTEM_PROGRAM,
        accounts: [
          { address: fundingInput.payer, role: AccountRole.WRITABLE_SIGNER },
          { address: fundingInput.destination, role: AccountRole.WRITABLE }
        ],
        data: transferData(fundingInput.lamports)
      }]
    });
    expect(isExpectedGasTankFundingMessage(messageOf(bundled), expected)).toBe(false);
  });

  it("refuses a different expected amount, payer or Gas Tank address", () => {
    const message = messageOf(walletEncoded({}));
    expect(isExpectedGasTankFundingMessage(message, { ...expected, lamports: "50000001" })).toBe(false);
    expect(isExpectedGasTankFundingMessage(message, { ...expected, lamports: "0" })).toBe(false);
    expect(isExpectedGasTankFundingMessage(message, { ...expected, lamports: "not-a-number" })).toBe(false);
    expect(
      isExpectedGasTankFundingMessage(message, {
        ...expected,
        payer: "SysvarC1ock11111111111111111111111111111111"
      })
    ).toBe(false);
    expect(
      isExpectedGasTankFundingMessage(message, {
        ...expected,
        destination: "SysvarC1ock11111111111111111111111111111111"
      })
    ).toBe(false);
  });

  it("refuses bytes that are not a compiled message", () => {
    expect(isExpectedGasTankFundingMessage(Uint8Array.from([0, 1, 2]), expected)).toBe(false);
  });
});
