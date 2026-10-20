import {
  findAssociatedTokenPda,
  getCreateAssociatedTokenIdempotentInstructionAsync,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS
} from "@solana-program/token-2022";
import {
  findWrappedMintAuthorityPda,
  findWrappedMintPda,
  getUnwrapInstruction
} from "@solana-program/token-wrap";
import {
  address,
  createNoopSigner,
  nonDivisibleSequentialInstructionPlan,
  type InstructionPlan
} from "@solana/kit";

const U64_MAX = (1n << 64n) - 1n;

export async function buildWrappedUsdcUnwrapPlan(input: {
  ownerAddress: string;
  wrappedMintAddress: string;
  unwrappedMintAddress: string;
  tokenWrapProgramAddress: string;
  amount: bigint;
}): Promise<{
  plan: InstructionPlan;
  sourceTokenAccount: string;
  destinationTokenAccount: string;
}> {
  if (input.amount <= 0n || input.amount > U64_MAX) {
    throw new Error("The unwrap amount must be a positive u64 value.");
  }

  const owner = address(input.ownerAddress);
  const wrappedMint = address(input.wrappedMintAddress);
  const unwrappedMint = address(input.unwrappedMintAddress);
  const tokenWrapProgram = address(input.tokenWrapProgramAddress);
  const [expectedWrappedMint] = await findWrappedMintPda(
    {
      unwrappedMint,
      wrappedTokenProgram: TOKEN_2022_PROGRAM_ADDRESS
    },
    { programAddress: tokenWrapProgram }
  );
  if (expectedWrappedMint !== wrappedMint) {
    throw new Error(
      "The configured wrapped-USDC mint does not derive from the configured Circle USDC mint and Token Wrap program."
    );
  }

  const [wrappedMintAuthority] = await findWrappedMintAuthorityPda(
    { wrappedMint },
    { programAddress: tokenWrapProgram }
  );
  const [sourceTokenAccount] = await findAssociatedTokenPda({
    owner,
    mint: wrappedMint,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS
  });
  const [destinationTokenAccount] = await findAssociatedTokenPda({
    owner,
    mint: unwrappedMint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS
  });
  const [unwrappedEscrow] = await findAssociatedTokenPda({
    owner: wrappedMintAuthority,
    mint: unwrappedMint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS
  });

  const payer = createNoopSigner(owner);
  const createDestinationAccount =
    await getCreateAssociatedTokenIdempotentInstructionAsync({
      payer,
      ata: destinationTokenAccount,
      owner,
      mint: unwrappedMint,
      tokenProgram: TOKEN_PROGRAM_ADDRESS
    });
  const unwrap = getUnwrapInstruction(
    {
      unwrappedEscrow,
      recipientUnwrappedToken: destinationTokenAccount,
      wrappedMintAuthority,
      unwrappedMint,
      wrappedTokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      unwrappedTokenProgram: TOKEN_PROGRAM_ADDRESS,
      wrappedTokenAccount: sourceTokenAccount,
      wrappedMint,
      transferAuthority: payer,
      amount: input.amount
    },
    { programAddress: tokenWrapProgram }
  );

  return {
    plan: nonDivisibleSequentialInstructionPlan([
      createDestinationAccount,
      unwrap
    ]),
    sourceTokenAccount,
    destinationTokenAccount
  };
}
