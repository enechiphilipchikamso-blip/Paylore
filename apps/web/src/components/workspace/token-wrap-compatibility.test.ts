import { TOKEN_2022_PROGRAM_ADDRESS, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { describe, expect, it } from "vitest";
import {
  assertDevnetTokenWrapIdentity,
  assertDevnetTokenWrapProgramAccount,
  assertExactFinalizedUnwrapBalances,
  assertExpectedAssociatedTokenAccount,
  DEVNET_TOKEN_WRAP_EXPECTED
} from "./token-wrap-compatibility";

const loader = "BPFLoaderUpgradeab1e11111111111111111111111";

const validIdentity = {
  programAddress: DEVNET_TOKEN_WRAP_EXPECTED.programAddress,
  wrappedMintAddress: DEVNET_TOKEN_WRAP_EXPECTED.wrappedMintAddress,
  unwrappedMintAddress: DEVNET_TOKEN_WRAP_EXPECTED.unwrappedMintAddress,
  wrappedMintProgramAddress: TOKEN_2022_PROGRAM_ADDRESS,
  unwrappedMintProgramAddress: TOKEN_PROGRAM_ADDRESS,
  derivedWrappedMintAddress: DEVNET_TOKEN_WRAP_EXPECTED.wrappedMintAddress,
  wrappedMintDecimals: 6,
  unwrappedMintDecimals: 6
};

describe("custom Devnet Token Wrap compatibility", () => {
  it("accepts only the configured program, deterministic mint pair, token owners and decimals", () => {
    expect(() => assertDevnetTokenWrapIdentity(validIdentity)).not.toThrow();
  });

  it.each([
    ["program", { programAddress: "11111111111111111111111111111111" }],
    ["wrapped mint", { wrappedMintAddress: "11111111111111111111111111111111" }],
    ["underlying mint", { unwrappedMintAddress: "11111111111111111111111111111111" }],
    ["derived mint", { derivedWrappedMintAddress: "11111111111111111111111111111111" }],
    ["wrapped token owner", { wrappedMintProgramAddress: TOKEN_PROGRAM_ADDRESS }],
    ["underlying token owner", { unwrappedMintProgramAddress: TOKEN_2022_PROGRAM_ADDRESS }],
    ["wrapped decimals", { wrappedMintDecimals: 9 }],
    ["underlying decimals", { unwrappedMintDecimals: 9 }]
  ])("rejects a mismatched %s", (_label, override) => {
    expect(() =>
      assertDevnetTokenWrapIdentity({ ...validIdentity, ...override })
    ).toThrow("No transaction was submitted");
  });

  it("requires the configured program to be executable under the upgradeable loader", () => {
    expect(() =>
      assertDevnetTokenWrapProgramAccount({
        programAddress: DEVNET_TOKEN_WRAP_EXPECTED.programAddress,
        ownerProgramAddress: loader,
        executable: true
      })
    ).not.toThrow();

    expect(() =>
      assertDevnetTokenWrapProgramAccount({
        programAddress: DEVNET_TOKEN_WRAP_EXPECTED.programAddress,
        ownerProgramAddress: TOKEN_PROGRAM_ADDRESS,
        executable: true
      })
    ).toThrow("not an executable deployed program");

    expect(() =>
      assertDevnetTokenWrapProgramAccount({
        programAddress: DEVNET_TOKEN_WRAP_EXPECTED.programAddress,
        ownerProgramAddress: loader,
        executable: false
      })
    ).toThrow("not an executable deployed program");
  });

  it("requires the deterministic public Circle-USDC destination and exact account identity", () => {
    const validDestination = {
      tokenAccountAddress: "destination-ata",
      expectedTokenAccountAddress: "destination-ata",
      tokenAccountProgramAddress: TOKEN_PROGRAM_ADDRESS,
      expectedTokenProgramAddress: TOKEN_PROGRAM_ADDRESS,
      tokenAccountOwnerAddress: "wallet",
      expectedOwnerAddress: "wallet",
      tokenAccountMintAddress: DEVNET_TOKEN_WRAP_EXPECTED.unwrappedMintAddress,
      expectedMintAddress: DEVNET_TOKEN_WRAP_EXPECTED.unwrappedMintAddress
    };

    expect(() => assertExpectedAssociatedTokenAccount(validDestination)).not.toThrow();
    expect(() =>
      assertExpectedAssociatedTokenAccount({
        ...validDestination,
        expectedTokenAccountAddress: "another-ata"
      })
    ).toThrow("deterministic token account");
    expect(() =>
      assertExpectedAssociatedTokenAccount({
        ...validDestination,
        tokenAccountOwnerAddress: "another-wallet"
      })
    ).toThrow("expected wallet, mint, and token program");
    expect(() =>
      assertExpectedAssociatedTokenAccount({
        ...validDestination,
        tokenAccountProgramAddress: TOKEN_2022_PROGRAM_ADDRESS
      })
    ).toThrow("expected wallet, mint, and token program");
  });

  it("requires exact finalized wrapped-token debit and Circle-USDC credit", () => {
    expect(() =>
      assertExactFinalizedUnwrapBalances({
        amountBaseUnits: 250_000n,
        sourceBalanceBefore: 1_000_000n,
        sourceBalanceAfter: 750_000n,
        destinationBalanceBefore: 100_000n,
        destinationBalanceAfter: 350_000n,
        transactionSignature: "signature"
      })
    ).not.toThrow();

    expect(() =>
      assertExactFinalizedUnwrapBalances({
        amountBaseUnits: 250_000n,
        sourceBalanceBefore: 1_000_000n,
        sourceBalanceAfter: 800_000n,
        destinationBalanceBefore: 100_000n,
        destinationBalanceAfter: 350_000n,
        transactionSignature: "signature"
      })
    ).toThrow("Do not submit a duplicate unwrap");

    expect(() =>
      assertExactFinalizedUnwrapBalances({
        amountBaseUnits: 250_000n,
        sourceBalanceBefore: 1_000_000n,
        sourceBalanceAfter: 750_000n,
        destinationBalanceBefore: 100_000n,
        destinationBalanceAfter: 300_000n,
        transactionSignature: "signature"
      })
    ).toThrow("Do not submit a duplicate unwrap");
  });
});
