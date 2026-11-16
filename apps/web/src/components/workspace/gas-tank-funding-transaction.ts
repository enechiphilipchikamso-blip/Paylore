import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase58Decoder,
  getCompiledTransactionMessageDecoder,
  getTransactionDecoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Transaction
} from "@solana/kit";
import {
  COMPUTE_BUDGET_PROGRAM_ID,
  GAS_TANK_FUNDING_ALLOWED_EXTRA_PROGRAM_IDS,
  GAS_TANK_FUNDING_MAX_INSTRUCTIONS,
  SOLANA_MAX_TRANSACTION_BYTES,
  SYSTEM_PROGRAM_ID
} from "./gas-tank-funding-programs";

const SYSTEM_PROGRAM_ADDRESS = address(SYSTEM_PROGRAM_ID);
const U64_MAX = (1n << 64n) - 1n;

export function solToLamports(value: string): string {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,9})?$/.test(value)) {
    throw new Error("Enter a SOL amount with up to nine decimal places.");
  }
  const [whole, fraction = ""] = value.split(".");
  const lamports =
    BigInt(whole) * 1_000_000_000n +
    BigInt((fraction + "000000000").slice(0, 9));
  if (lamports <= 0n || lamports > U64_MAX) {
    throw new Error("Enter a positive SOL amount within the supported range.");
  }
  return lamports.toString();
}

export type GasTankFundingInput = {
  payer: string;
  destination: string;
  lamports: string;
  blockhash: string;
  lastValidBlockHeight: number;
};

/** What the reviewed transfer must still do after a wallet has signed it. */
export type GasTankFundingExpectation = {
  payer: string;
  destination: string;
  lamports: string;
};

/** System Program `Transfer` instruction data: u32 index 2, then the u64 amount. */
function systemTransferData(amount: bigint): Uint8Array {
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, amount, true);
  return data;
}

function bytesEqual(left: ArrayLike<number>, right: ArrayLike<number>): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}

export function createGasTankFundingTransaction(
  input: GasTankFundingInput
): Uint8Array {
  const amount = BigInt(input.lamports);
  if (amount <= 0n || amount > U64_MAX) {
    throw new Error("Funding amount is outside the supported range.");
  }

  const payer = address(input.payer);
  const destination = address(input.destination);
  const transfer = {
    programAddress: SYSTEM_PROGRAM_ADDRESS,
    accounts: [
      { address: payer, role: AccountRole.WRITABLE_SIGNER },
      { address: destination, role: AccountRole.WRITABLE }
    ],
    data: systemTransferData(amount)
  } as const;
  const message = appendTransactionMessageInstructions(
    [transfer],
    setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash(input.blockhash),
        lastValidBlockHeight: BigInt(input.lastValidBlockHeight)
      },
      setTransactionMessageFeePayer(
        payer,
        createTransactionMessage({ version: 0 })
      )
    )
  );
  const wire = getBase64EncodedWireTransaction(
    compileTransaction(message)
  );
  return Uint8Array.from(atob(wire), (character) =>
    character.charCodeAt(0)
  );
}

export function gasTankFundingSignature(
  signature: Uint8Array
): string {
  return getBase58Decoder().decode(signature);
}

export const GAS_TANK_FUNDING_CHANGED =
  "The wallet changed the funding transaction while signing, so it no longer matches the transfer you reviewed (payer, Gas Tank address or amount). No funding was sent.";

function decodeCompiledMessage(messageBytes: Uint8Array) {
  try {
    return getCompiledTransactionMessageDecoder().decode(messageBytes);
  } catch {
    return null;
  }
}

/**
 * True when a signed message still does exactly the reviewed transfer.
 *
 * Wallets legitimately re-encode a transaction while signing: they add
 * priority-fee (Compute Budget) or guard (Lighthouse) instructions, refresh the
 * blockhash, or re-serialize between legacy and v0. Byte equality rejects all of
 * that, so this checks meaning instead:
 *
 * - the wallet is the only signer and the fee payer;
 * - there is no address-table lookup that could hide an account;
 * - exactly one System Program instruction exists, and it is a transfer of the
 *   reviewed amount from the payer to the Gas Tank address;
 * - every other instruction belongs to an allowlisted program that cannot move
 *   the payer's SOL, and Compute Budget instructions carry no accounts.
 *
 * The blockhash is intentionally not compared: a stale one fails the network's
 * pre-flight simulation and is reported as a rejected transaction.
 */
export function isExpectedGasTankFundingMessage(
  messageBytes: Uint8Array,
  expected: GasTankFundingExpectation
): boolean {
  let amount: bigint;
  try {
    amount = BigInt(expected.lamports);
  } catch {
    return false;
  }
  if (amount <= 0n || amount > U64_MAX) return false;

  const message = decodeCompiledMessage(messageBytes);
  if (!message) return false;
  if (message.version === 1) return false;
  if (message.version === 0 && message.addressTableLookups?.length) {
    return false;
  }
  if (message.header.numSignerAccounts !== 1) return false;

  const accounts = message.staticAccounts;
  if (accounts[0] !== expected.payer) return false;
  if (
    message.instructions.length === 0 ||
    message.instructions.length > GAS_TANK_FUNDING_MAX_INSTRUCTIONS
  ) {
    return false;
  }

  const expectedData = systemTransferData(amount);
  let transfers = 0;
  for (const instruction of message.instructions) {
    const program = accounts[instruction.programAddressIndex];
    if (!program) return false;
    const indices = instruction.accountIndices ?? [];

    if (program === SYSTEM_PROGRAM_ID) {
      if (
        indices.length !== 2 ||
        accounts[indices[0]] !== expected.payer ||
        accounts[indices[1]] !== expected.destination ||
        !bytesEqual(instruction.data ?? new Uint8Array(), expectedData)
      ) {
        return false;
      }
      transfers += 1;
      continue;
    }

    if (!GAS_TANK_FUNDING_ALLOWED_EXTRA_PROGRAM_IDS.has(program)) return false;
    if (program === COMPUTE_BUDGET_PROGRAM_ID && indices.length !== 0) {
      return false;
    }
  }
  return transfers === 1;
}

/** Confirms the wallet signed the reviewed transfer and returns what Paylore submits. */
export function signedGasTankFunding(
  signed: Uint8Array,
  expected: GasTankFundingExpectation
): { signature: string; transactionBase64: string } {
  if (signed.length > SOLANA_MAX_TRANSACTION_BYTES) {
    throw new Error(GAS_TANK_FUNDING_CHANGED);
  }
  let signedTransaction: Transaction;
  try {
    signedTransaction = getTransactionDecoder().decode(signed);
  } catch {
    throw new Error(GAS_TANK_FUNDING_CHANGED);
  }
  if (
    !isExpectedGasTankFundingMessage(
      Uint8Array.from(signedTransaction.messageBytes),
      expected
    )
  ) {
    throw new Error(GAS_TANK_FUNDING_CHANGED);
  }
  const payerSignature = signedTransaction.signatures[address(expected.payer)];
  if (!payerSignature || payerSignature.every((byte) => byte === 0)) {
    throw new Error("The wallet did not sign the funding transaction. No funding was sent.");
  }
  return {
    signature: gasTankFundingSignature(payerSignature),
    transactionBase64: btoa(
      Array.from(signed, (byte) => String.fromCharCode(byte)).join("")
    )
  };
}
