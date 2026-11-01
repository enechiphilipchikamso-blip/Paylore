import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getBase58Decoder,
  getTransactionDecoder,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash
} from "@solana/kit";

const SYSTEM_PROGRAM_ADDRESS = address(
  "11111111111111111111111111111111"
);
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

export function createGasTankFundingTransaction(
  input: GasTankFundingInput
): Uint8Array {
  const amount = BigInt(input.lamports);
  if (amount <= 0n || amount > U64_MAX) {
    throw new Error("Funding amount is outside the supported range.");
  }

  const payer = address(input.payer);
  const destination = address(input.destination);
  const data = new Uint8Array(12);
  const view = new DataView(data.buffer);
  view.setUint32(0, 2, true);
  view.setBigUint64(4, amount, true);
  const transfer = {
    programAddress: SYSTEM_PROGRAM_ADDRESS,
    accounts: [
      { address: payer, role: AccountRole.WRITABLE_SIGNER },
      { address: destination, role: AccountRole.WRITABLE }
    ],
    data
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
  "The wallet changed the funding transaction while signing. No funding was sent.";

/** Confirms the wallet signed the exact reviewed transfer and returns what Paylore submits. */
export function signedGasTankFunding(
  reviewed: Uint8Array,
  signed: Uint8Array,
  payer: string
): { signature: string; transactionBase64: string } {
  const decoder = getTransactionDecoder();
  const reviewedMessage = Uint8Array.from(decoder.decode(reviewed).messageBytes);
  const signedTransaction = decoder.decode(signed);
  const signedMessage = Uint8Array.from(signedTransaction.messageBytes);
  if (
    reviewedMessage.length !== signedMessage.length ||
    reviewedMessage.some((byte, index) => byte !== signedMessage[index])
  ) {
    throw new Error(GAS_TANK_FUNDING_CHANGED);
  }
  const payerSignature = signedTransaction.signatures[address(payer)];
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
