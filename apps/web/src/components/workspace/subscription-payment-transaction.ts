import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getBase58Decoder,
  getProgramDerivedAddress,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash
} from "@solana/kit";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";

const ASSOCIATED_TOKEN_PROGRAM_ADDRESS =
  address("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL");
const SYSTEM_PROGRAM_ADDRESS =
  address("11111111111111111111111111111111");
const MEMO_PROGRAM_ADDRESS =
  address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
const SPL_TOKEN_PROGRAM_ADDRESS =
  address("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
const BASE_UNITS = 49_000_000n;
const USDC_DECIMALS = 6;

export type SubscriptionPaymentTransactionInput = {
  payer: string;
  recipient: string;
  mint: string;
  tokenProgram: string;
  workspaceId: string;
  blockhash: string;
  lastValidBlockHeight: number;
  memo: string;
};

async function deriveAssociatedTokenAddress(
  owner: ReturnType<typeof address>,
  mint: ReturnType<typeof address>,
  tokenProgram: ReturnType<typeof address>
) {
  const encoder = getAddressEncoder();
  const [associatedTokenAddress] = await getProgramDerivedAddress({
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    seeds: [
      encoder.encode(owner),
      encoder.encode(tokenProgram),
      encoder.encode(mint)
    ]
  });
  return associatedTokenAddress;
}

export async function createSubscriptionPaymentTransaction({
  payer: payerText,
  recipient: recipientText,
  mint: mintText,
  tokenProgram: tokenProgramText,
  blockhash: blockhashText,
  lastValidBlockHeight,
  memo
}: SubscriptionPaymentTransactionInput): Promise<Uint8Array> {
  const payer = address(payerText);
  const recipient = address(recipientText);
  const mint = address(mintText);
  const tokenProgram = address(tokenProgramText);
  if (
    tokenProgram !== TOKEN_2022_PROGRAM_ADDRESS &&
    tokenProgram !== SPL_TOKEN_PROGRAM_ADDRESS
  ) {
    throw new Error("The subscription mint uses an unsupported token program.");
  }
  const recentBlockhash = blockhash(blockhashText);
  const source = await deriveAssociatedTokenAddress(payer, mint, tokenProgram);
  const destination = await deriveAssociatedTokenAddress(recipient, mint, tokenProgram);

  const createDestinationAccount = {
    programAddress: ASSOCIATED_TOKEN_PROGRAM_ADDRESS,
    accounts: [
      { address: payer, role: AccountRole.WRITABLE_SIGNER },
      { address: destination, role: AccountRole.WRITABLE },
      { address: recipient, role: AccountRole.READONLY },
      { address: mint, role: AccountRole.READONLY },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY },
      { address: tokenProgram, role: AccountRole.READONLY }
    ],
    data: new Uint8Array([1])
  } as const;

  const amountBytes = new Uint8Array(8);
  new DataView(amountBytes.buffer).setBigUint64(0, BASE_UNITS, true);
  const transferData = new Uint8Array(10);
  transferData[0] = 12;
  transferData.set(amountBytes, 1);
  transferData[9] = USDC_DECIMALS;

  const transfer = {
    programAddress: tokenProgram,
    accounts: [
      { address: source, role: AccountRole.WRITABLE },
      { address: mint, role: AccountRole.READONLY },
      { address: destination, role: AccountRole.WRITABLE },
      { address: payer, role: AccountRole.READONLY_SIGNER }
    ],
    data: transferData
  } as const;

  const memoInstruction = {
    programAddress: MEMO_PROGRAM_ADDRESS,
    accounts: [],
    data: new TextEncoder().encode(memo)
  } as const;

  const message = appendTransactionMessageInstructions(
    [createDestinationAccount, transfer, memoInstruction],
    setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: recentBlockhash,
        lastValidBlockHeight: BigInt(lastValidBlockHeight)
      },
      setTransactionMessageFeePayer(
        payer,
        createTransactionMessage({ version: 0 })
      )
    )
  );

  const wireTransaction = getBase64EncodedWireTransaction(
    compileTransaction(message)
  );
  return Uint8Array.from(atob(wireTransaction), (character) =>
    character.charCodeAt(0)
  );
}

export function subscriptionPaymentSignature(
  signature: Uint8Array
): string {
  return getBase58Decoder().decode(signature);
}
