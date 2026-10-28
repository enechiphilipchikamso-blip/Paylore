import "server-only";

import {
  address,
  createKeyPairSignerFromBytes,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
  verifySignature,
  type Transaction
} from "@solana/kit";
import {
  assertAllowedConfidentialAccountSetupMessage,
  assertSponsoredCost,
  assertSimulationSucceeded,
  GasTankSponsorshipPolicyError,
  MAX_CONFIDENTIAL_ACCOUNT_SETUP_RENT_LAMPORTS,
  MAX_SPONSORED_TRANSACTION_BYTES
} from "./gas-tank-sponsorship-policy";
import { readSolanaRpc } from "./solana/rpc";

export type InspectedConfidentialSetupTransaction = {
  transaction: Transaction;
  messageBytes: Uint8Array;
  recentBlockhash: string;
  feeLamports: bigint | null;
  reservedRentLamports: bigint;
  transactionBytes: number;
};

/** Verifies the contributor's signature and the complete compiled message before a sponsor key is opened. */
export async function inspectSponsoredConfidentialSetupTransaction(input: {
  transactionBase64: string;
  ownerAddress: string;
  mintAddress: string;
  tokenAccountAddress: string;
  token2022ProgramAddress: string;
  gasTankAddress: string;
  balanceLamports: string;
  dailyBookedFeesLamports: bigint;
  dailyOperationCount: number;
  deferCostCheck?: boolean;
}): Promise<InspectedConfidentialSetupTransaction> {
  if (
    !input.transactionBase64 ||
    input.transactionBase64.length > 4_096 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(input.transactionBase64)
  ) {
    throw new GasTankSponsorshipPolicyError("sponsored_transaction_encoding_invalid");
  }
  const wireBytes = Buffer.from(input.transactionBase64, "base64");
  if (wireBytes.toString("base64") !== input.transactionBase64 ||
      wireBytes.length < 1 || wireBytes.length > MAX_SPONSORED_TRANSACTION_BYTES) {
    throw new GasTankSponsorshipPolicyError("sponsored_transaction_encoding_invalid");
  }

  let transaction: Transaction;
  let message: ReturnType<ReturnType<typeof getCompiledTransactionMessageDecoder>["decode"]>;
  try {
    transaction = getTransactionDecoder().decode(wireBytes);
    message = getCompiledTransactionMessageDecoder().decode(transaction.messageBytes);
  } catch {
    throw new GasTankSponsorshipPolicyError("sponsored_transaction_encoding_invalid");
  }

  if (message.staticAccounts[0] !== input.gasTankAddress) {
    throw new GasTankSponsorshipPolicyError("confidential_setup_fee_payer_denied");
  }
  if (message.version !== 0) {
    throw new GasTankSponsorshipPolicyError("confidential_setup_transaction_invalid");
  }
  const feePayerAddress = address(input.gasTankAddress);
  const ownerAddress = address(input.ownerAddress);
  if (transaction.signatures[feePayerAddress] &&
      !transaction.signatures[feePayerAddress]!.every((byte) => byte === 0)) {
    throw new GasTankSponsorshipPolicyError("confidential_setup_fee_payer_already_signed");
  }
  const contributorSignature = transaction.signatures[ownerAddress];
  if (!contributorSignature || contributorSignature.every((byte) => byte === 0)) {
    throw new GasTankSponsorshipPolicyError("confidential_setup_owner_signature_required");
  }
  const publicKey = await crypto.subtle.importKey(
    "raw",
    Uint8Array.from(getAddressEncoder().encode(ownerAddress)),
    { name: "Ed25519" },
    true,
    ["verify"]
  );
  if (!(await verifySignature(publicKey, contributorSignature, transaction.messageBytes))) {
    throw new GasTankSponsorshipPolicyError("confidential_setup_owner_signature_invalid");
  }

  const { reservedRentLamports } = assertAllowedConfidentialAccountSetupMessage({
    message: {
      version: message.version,
      staticAccounts: message.staticAccounts,
      header: message.header,
      instructions: message.instructions.map((instruction) => ({
        programAddressIndex: instruction.programAddressIndex,
        accountIndices: instruction.accountIndices,
        data: instruction.data
      })),
      addressTableLookups: []
    },
    feePayerAddress: input.gasTankAddress,
    ownerAddress: input.ownerAddress,
    mintAddress: input.mintAddress,
    tokenAccountAddress: input.tokenAccountAddress,
    token2022ProgramAddress: input.token2022ProgramAddress
  });
  if (reservedRentLamports > MAX_CONFIDENTIAL_ACCOUNT_SETUP_RENT_LAMPORTS) {
    throw new GasTankSponsorshipPolicyError("confidential_setup_rent_limit_exceeded");
  }

  const fee = await readSolanaRpc<{ value: number | null }>("getFeeForMessage", [
    Buffer.from(transaction.messageBytes).toString("base64"),
    { commitment: "confirmed" }
  ]);
  if (fee.value !== null && (!Number.isSafeInteger(fee.value) || fee.value < 0)) {
    throw new GasTankSponsorshipPolicyError("sponsored_fee_unavailable");
  }
  if (fee.value === null && !input.deferCostCheck) {
    throw new GasTankSponsorshipPolicyError("sponsored_fee_unavailable");
  }
  if (fee.value !== null && !input.deferCostCheck) {
    assertSponsoredCost({
      transactionBytes: wireBytes.length,
      feeLamports: BigInt(fee.value),
      balanceLamports: BigInt(input.balanceLamports),
      dailyBookedFeesLamports: input.dailyBookedFeesLamports,
      dailyOperationCount: input.dailyOperationCount
    });
  }
  return {
    transaction,
    messageBytes: new Uint8Array(transaction.messageBytes),
    recentBlockhash: message.lifetimeToken,
    feeLamports: fee.value === null ? null : BigInt(fee.value),
    reservedRentLamports,
    transactionBytes: wireBytes.length
  };
}

/** Adds only the Gas Tank fee-payer signature, then simulates and submits the exact contributor-approved message. */
export async function submitSponsoredConfidentialSetupTransaction(input: {
  transaction: Transaction;
  gasTankAddress: string;
  gasTankPrivateKey: Uint8Array;
  feeLamports: bigint;
}): Promise<{ signature: string; feeLamports: string }> {
  const secretCopy = new Uint8Array(input.gasTankPrivateKey);
  try {
    const sponsor = await createKeyPairSignerFromBytes(secretCopy);
    if (sponsor.address !== input.gasTankAddress) {
      throw new GasTankSponsorshipPolicyError("gas_tank_key_identity_mismatch");
    }
    const signed = await partiallySignTransaction([sponsor.keyPair], input.transaction);
    const transactionSignature = String(getSignatureFromTransaction(signed));
    const wireBase64 = getBase64EncodedWireTransaction(signed);
    const simulation = await readSolanaRpc<unknown>("simulateTransaction", [
      wireBase64,
      {
        encoding: "base64",
        commitment: "confirmed",
        sigVerify: true,
        replaceRecentBlockhash: false,
        innerInstructions: false
      }
    ]);
    assertSimulationSucceeded(simulation);
    const sentSignature = await readSolanaRpc<string>("sendTransaction", [
      wireBase64,
      {
        encoding: "base64",
        skipPreflight: false,
        preflightCommitment: "confirmed",
        maxRetries: 3
      }
    ]);
    if (sentSignature !== transactionSignature) {
      throw new GasTankSponsorshipPolicyError("sponsored_transaction_signature_mismatch");
    }
    return { signature: transactionSignature, feeLamports: String(input.feeLamports) };
  } finally {
    secretCopy.fill(0);
  }
}
