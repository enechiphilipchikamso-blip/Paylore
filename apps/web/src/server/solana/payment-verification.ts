import "server-only";

import { loadPayloreConfig } from "../config";
import { isValidSolanaAddress } from "../security";
import { readSolanaRpc } from "./rpc";

export const SUBSCRIPTION_PRICE_BASE_UNITS = "49000000";

type ParsedInstruction = {
  program?: string;
  parsed?: {
    type?: string;
    info?: {
      source?: string;
      destination?: string;
      mint?: string;
      authority?: string;
      amount?: string;
      tokenAmount?: {
        amount?: string;
        decimals?: number;
      };
    };
  };
};

type TokenBalance = {
  accountIndex: number;
  mint: string;
  owner?: string;
  uiTokenAmount?: {
    amount?: string;
    decimals?: number;
  };
};

type ParsedTransaction = {
  transaction?: {
    message?: {
      accountKeys?: Array<
        | string
        | { pubkey?: string; signer?: boolean }
      >;
      instructions?: ParsedInstruction[];
    };
  };
  meta?: {
    err?: unknown;
    preTokenBalances?: TokenBalance[];
    postTokenBalances?: TokenBalance[];
  } | null;
};

export class PaymentVerificationError extends Error {
  constructor(
    readonly reason:
      | "configuration"
      | "not_found"
      | "failed"
      | "wrong_payment"
  ) {
    super("Payment could not be verified.");
    this.name = "PaymentVerificationError";
  }
}

function addressesFromTransaction(
  transaction: ParsedTransaction
): Array<{ address: string; signer: boolean }> {
  const accountKeys =
    transaction.transaction?.message?.accountKeys ?? [];
  return accountKeys.map((key) =>
    typeof key === "string"
      ? { address: key, signer: false }
      : {
          address: key.pubkey ?? "",
          signer: key.signer === true
        }
  );
}

function isTransaction(value: unknown): value is ParsedTransaction {
  return Boolean(
    value &&
      typeof value === "object" &&
      "transaction" in value &&
      "meta" in value
  );
}

export async function verifySubscriptionPayment(
  signature: string,
  payerAddress: string
) {
  const config = loadPayloreConfig();
  const recipient = config.PAYLORE_SUBSCRIPTION_RECIPIENT;
  const mint = config.PAYLORE_SUBSCRIPTION_USDC_MINT;

  if (
    !recipient ||
    !mint ||
    !isValidSolanaAddress(recipient) ||
    !isValidSolanaAddress(mint)
  ) {
    throw new PaymentVerificationError("configuration");
  }

  const transactionValue =
    await readSolanaRpc<unknown>("getTransaction", [
      signature,
      {
        commitment: "finalized",
        encoding: "jsonParsed",
        maxSupportedTransactionVersion: 0
      }
    ]);

  if (!transactionValue) {
    throw new PaymentVerificationError("not_found");
  }
  if (!isTransaction(transactionValue)) {
    throw new PaymentVerificationError("failed");
  }

  const transaction = transactionValue;
  const meta = transaction.meta;
  const message = transaction.transaction?.message;
  if (
    !meta ||
    meta.err ||
    !message ||
    !Array.isArray(message.instructions)
  ) {
    throw new PaymentVerificationError("failed");
  }

  const accountKeys = addressesFromTransaction(transaction);
  if (!accountKeys.some((key) =>
    key.address === payerAddress && key.signer
  )) {
    throw new PaymentVerificationError("wrong_payment");
  }

  const instructions = message.instructions.filter(
    (instruction) =>
      instruction.program === "spl-token" ||
      instruction.program === "spl-token-2022"
  );

  let verifiedAmount = 0n;
  for (const instruction of instructions) {
    const info = instruction.parsed?.info;
    if (
      instruction.parsed?.type !== "transferChecked" ||
      !info?.source ||
      !info.destination ||
      info.mint !== mint
    ) {
      continue;
    }

    const destinationIndex = accountKeys.findIndex(
      (key) => key.address === info.destination
    );
    const destinationBalance =
      meta.postTokenBalances?.find(
        (balance) =>
          balance.accountIndex === destinationIndex &&
          balance.mint === mint &&
          balance.owner === recipient
      );
    const sourceIndex = accountKeys.findIndex(
      (key) => key.address === info.source
    );
    const sourceBalance =
      meta.preTokenBalances?.find(
        (balance) =>
          balance.accountIndex === sourceIndex &&
          balance.mint === mint &&
          balance.owner === payerAddress
      );
    const amount =
      info.tokenAmount?.amount;
    const decimals =
      info.tokenAmount?.decimals;

    if (
      !destinationBalance ||
      !sourceBalance ||
      decimals !== 6 ||
      !amount ||
      !/^\d+$/.test(amount)
    ) {
      continue;
    }

    verifiedAmount += BigInt(amount);
  }

  if (
    verifiedAmount !==
    BigInt(SUBSCRIPTION_PRICE_BASE_UNITS)
  ) {
    throw new PaymentVerificationError("wrong_payment");
  }

  return {
    signature,
    payerAddress,
    recipient,
    mint,
    amountBaseUnits: SUBSCRIPTION_PRICE_BASE_UNITS
  };
}
