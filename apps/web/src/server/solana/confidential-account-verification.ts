import "server-only";

import {
  address,
  type Address
} from "@solana/kit";
import {
  findAssociatedTokenPda,
  TOKEN_2022_PROGRAM_ADDRESS
} from "@solana-program/token-2022";
import { readSolanaRpc } from "./rpc";

type ParsedInstruction = {
  programId?: unknown;
  parsed?: {
    type?: unknown;
    info?: Record<string, unknown>;
  };
};

export class ConfidentialAccountVerificationError extends Error {
  constructor(readonly code: "confidential_account_not_ready" | "confidential_account_close_mismatch") {
    super(code);
    this.name = "ConfidentialAccountVerificationError";
  }
}

function hasAccountExtension(info: Record<string, unknown>, expectedExtension: string): boolean {
  if (!Array.isArray(info.extensions)) return false;
  return info.extensions.some((value) => {
    const extension = object(value);
    const name = extension?.extension;
    return typeof name === "string" &&
      name.replace(/[^a-z]/gi, "").toLowerCase() === expectedExtension;
  });
}

function accountExtensionState(info: Record<string, unknown>, expectedExtension: string): Record<string, unknown> | null {
  if (!Array.isArray(info.extensions)) return null;
  for (const value of info.extensions) {
    const extension = object(value);
    if (!extension) continue;
    const name = extension.extension;
    if (typeof name !== "string" || name.replace(/[^a-z]/gi, "").toLowerCase() !== expectedExtension) continue;
    return object(extension.state);
  }
  return null;
}


type ParsedTransaction = {
  slot?: unknown;
  transaction?: {
    signatures?: unknown;
    message?: {
      accountKeys?: unknown;
      instructions?: unknown;
    };
  };
  meta?: {
    err?: unknown;
  } | null;
} | null;

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? value as Record<string, unknown>
    : null;
}

function isAddressInAccountKeys(
  accountKeys: unknown,
  expected: string
): boolean {
  if (!Array.isArray(accountKeys)) return false;
  return accountKeys.some((entry) => {
    if (typeof entry === "string") return entry === expected;
    return object(entry)?.pubkey === expected;
  });
}

async function getFinalizedParsedTransaction(
  signature: string
): Promise<{
  instructions: ParsedInstruction[];
  accountKeys: unknown;
}> {
  const transaction = await readSolanaRpc<ParsedTransaction>(
    "getTransaction",
    [
      signature,
      {
        encoding: "jsonParsed",
        commitment: "finalized",
        maxSupportedTransactionVersion: 0
      }
    ]
  );
  const tx = object(transaction);
  const meta = object(tx?.meta);
  const transactionBody = object(tx?.transaction);
  const message = object(transactionBody?.message);
  const instructions = message?.instructions;
  const signatures = transactionBody?.signatures;
  if (
    !tx ||
    !meta ||
    meta.err !== null ||
    !Array.isArray(signatures) ||
    !signatures.includes(signature) ||
    !message ||
    !Array.isArray(instructions) ||
    typeof tx.slot !== "number"
  ) {
    throw new Error("The submitted transaction is not finalized successfully.");
  }
  return {
    instructions: instructions as ParsedInstruction[],
    accountKeys: message.accountKeys
  };
}

async function expectedTokenAccount(
  walletAddress: string,
  mintAddress: string
): Promise<Address> {
  const [tokenAccount] = await findAssociatedTokenPda({
    owner: address(walletAddress),
    mint: address(mintAddress),
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS
  });
  return tokenAccount;
}

export async function verifyConfidentialAccountSetup(
  input: {
    signature: string;
    walletAddress: string;
    mintAddress: string;
  }
): Promise<string> {
  const tokenAccount = await expectedTokenAccount(
    input.walletAddress,
    input.mintAddress
  );
  const transaction = await getFinalizedParsedTransaction(input.signature);
  const hasSetupInstruction = transaction.instructions.some((instruction) => {
    const parsed = object(instruction.parsed);
    const info = object(parsed?.info);
    return (
      instruction.programId === TOKEN_2022_PROGRAM_ADDRESS &&
      parsed?.type === "configureConfidentialTransferAccount" &&
      info?.token === tokenAccount &&
      info?.mint === input.mintAddress &&
      (info?.authority === input.walletAddress || info?.owner === input.walletAddress) &&
      isAddressInAccountKeys(transaction.accountKeys, input.walletAddress)
    );
  });
  if (!hasSetupInstruction) {
    throw new Error(
      "The finalized transaction does not configure this wallet's confidential Token-2022 account."
    );
  }
  const accountInfo = await readSolanaRpc<{
    value: {
      owner?: unknown;
      data?: { parsed?: { type?: unknown; info?: Record<string, unknown> } };
    } | null;
  }>("getAccountInfo", [
    tokenAccount,
    { commitment: "finalized", encoding: "jsonParsed" }
  ]);
  const value = object(accountInfo.value);
  const data = object(value?.data);
  const parsed = object(data?.parsed);
  const info = object(parsed?.info);
  const immutableOwnerPresent = info ? hasAccountExtension(info, "immutableowner") : false;
  const confidentialState = info ? accountExtensionState(info, "confidentialtransferaccount") : null;
  const approved = confidentialState?.approved === true;
  const confidentialCreditsAllowed =
    confidentialState?.allowConfidentialCredits === true ||
    confidentialState?.allow_confidential_credits === true;
  if (
    value?.owner !== TOKEN_2022_PROGRAM_ADDRESS ||
    parsed?.type !== "account" ||
    info?.owner !== input.walletAddress ||
    info?.mint !== input.mintAddress ||
    !immutableOwnerPresent ||
    !confidentialState ||
    !approved ||
    !confidentialCreditsAllowed
  ) {
    throw new ConfidentialAccountVerificationError("confidential_account_not_ready");
  }
  return tokenAccount;
}

export async function verifyConfidentialAccountClose(
  input: {
    signature: string;
    walletAddress: string;
    mintAddress: string;
  }
): Promise<string> {
  const tokenAccount = await expectedTokenAccount(
    input.walletAddress,
    input.mintAddress
  );
  const transaction = await getFinalizedParsedTransaction(input.signature);
  const hasCloseInstruction = transaction.instructions.some((instruction) => {
    const parsed = object(instruction.parsed);
    const info = object(parsed?.info);
    return (
      instruction.programId === TOKEN_2022_PROGRAM_ADDRESS &&
      parsed?.type === "closeAccount" &&
      info?.account === tokenAccount &&
      info?.destination === input.walletAddress &&
      (info?.owner === input.walletAddress ||
        info?.authority === input.walletAddress) &&
      isAddressInAccountKeys(transaction.accountKeys, input.walletAddress)
    );
  });
  if (!hasCloseInstruction) {
    throw new ConfidentialAccountVerificationError("confidential_account_close_mismatch");
  }
  const accountInfo = await readSolanaRpc<{
    value: unknown | null;
  }>("getAccountInfo", [
    tokenAccount,
    { commitment: "finalized", encoding: "base64" }
  ]);
  if (accountInfo.value !== null) {
    throw new Error(
      "The confidential Token-2022 account still exists after the close transaction finalized."
    );
  }
  return tokenAccount;
}
