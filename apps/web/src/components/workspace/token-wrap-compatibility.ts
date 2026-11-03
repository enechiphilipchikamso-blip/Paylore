import {
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS
} from "@solana-program/token-2022";

export const TOKEN_WRAP_EXPECTED = {
  programAddress: "",
  wrappedMintAddress: "",
  unwrappedMintAddress: "",
  wrappedMintProgramAddress: TOKEN_2022_PROGRAM_ADDRESS,
  unwrappedMintProgramAddress: TOKEN_PROGRAM_ADDRESS,
  decimals: 6
} as const;

const UPGRADEABLE_LOADER_ADDRESS =
  "BPFLoaderUpgradeab1e11111111111111111111111";

export function assertTokenWrapProgramAccount(input: {
  programAddress: string;
  ownerProgramAddress: string;
  executable: boolean;
}): void {
  if (
    !input.executable ||
    input.ownerProgramAddress !== UPGRADEABLE_LOADER_ADDRESS
  ) {
    throw new Error(
      "The configured Token Wrap program is not an executable deployed program. No transaction was submitted."
    );
  }
}

export function assertTokenWrapIdentity(input: {
  programAddress: string;
  wrappedMintAddress: string;
  unwrappedMintAddress: string;
  wrappedMintProgramAddress: string;
  unwrappedMintProgramAddress: string;
  derivedWrappedMintAddress: string;
  wrappedMintDecimals: number;
  unwrappedMintDecimals: number;
}): void {
  if (
    input.wrappedMintProgramAddress !==
      TOKEN_WRAP_EXPECTED.wrappedMintProgramAddress ||
    input.unwrappedMintProgramAddress !==
      TOKEN_WRAP_EXPECTED.unwrappedMintProgramAddress
  ) {
    throw new Error(
      "The wrapped and underlying USDC mints are not owned by their expected token programs. No transaction was submitted."
    );
  }

  if (input.derivedWrappedMintAddress !== input.wrappedMintAddress) {
    throw new Error(
      "The wrapped-USDC mint does not derive from the configured Circle mint and Token Wrap program. No transaction was submitted."
    );
  }

  if (
    input.wrappedMintDecimals !== 6 ||
    input.unwrappedMintDecimals !== 6 ||
    input.wrappedMintDecimals !== input.unwrappedMintDecimals
  ) {
    throw new Error(
      "Both USDC mints must use six decimals. No transaction was submitted."
    );
  }
}


export function assertExpectedAssociatedTokenAccount(input: {
  tokenAccountAddress: string;
  expectedTokenAccountAddress: string;
  tokenAccountProgramAddress: string;
  expectedTokenProgramAddress: string;
  tokenAccountOwnerAddress: string;
  expectedOwnerAddress: string;
  tokenAccountMintAddress: string;
  expectedMintAddress: string;
}): void {
  if (input.tokenAccountAddress !== input.expectedTokenAccountAddress) {
    throw new Error(
      "The Circle-USDC destination is not the connected wallet's deterministic token account. No transaction was submitted."
    );
  }
  if (
    input.tokenAccountProgramAddress !==
      input.expectedTokenProgramAddress ||
    input.tokenAccountOwnerAddress !== input.expectedOwnerAddress ||
    input.tokenAccountMintAddress !== input.expectedMintAddress
  ) {
    throw new Error(
      "The public token account does not match the expected wallet, mint, and token program. No transaction was submitted."
    );
  }
}

export function assertExactFinalizedUnwrapBalances(input: {
  amountBaseUnits: bigint;
  sourceBalanceBefore: bigint;
  sourceBalanceAfter: bigint;
  destinationBalanceBefore: bigint;
  destinationBalanceAfter: bigint;
  transactionSignature: string;
}): void {
  const sourceDebit = input.sourceBalanceBefore - input.sourceBalanceAfter;
  const destinationCredit =
    input.destinationBalanceAfter - input.destinationBalanceBefore;

  if (
    input.amountBaseUnits <= 0n ||
    sourceDebit !== input.amountBaseUnits ||
    destinationCredit !== input.amountBaseUnits
  ) {
    throw new Error(
      `The unwrap finalized, but the exact wrapped-token debit and Circle-USDC credit could not be reconciled. Do not submit a duplicate unwrap. Transaction: ${input.transactionSignature}`
    );
  }
}

export function assertExactFinalizedWrapBalances(input: {
  amountBaseUnits: bigint;
  sourceDebitBaseUnits: bigint;
  escrowCreditBaseUnits: bigint;
  destinationCreditBaseUnits: bigint;
  transactionSignature: string;
}): void {
  // The escrow is shared across wraps, so compare token-balance deltas from this signature's transaction metadata, not separate global snapshots.
  if (
    input.amountBaseUnits <= 0n ||
    input.sourceDebitBaseUnits !== input.amountBaseUnits ||
    input.escrowCreditBaseUnits !== input.amountBaseUnits ||
    input.destinationCreditBaseUnits !== input.amountBaseUnits
  ) {
    throw new Error(
      `The finalized wrap transaction does not reconcile to the requested Circle-USDC debit, Token Wrap escrow credit and Reserve wrapped-USDC credit. Do not submit a duplicate wrap. Transaction: ${input.transactionSignature}`
    );
  }
}
