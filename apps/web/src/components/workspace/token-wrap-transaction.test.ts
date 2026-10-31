import {
  findAssociatedTokenPda,
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS
} from "@solana-program/token-2022";
import { address } from "@solana/kit";
import { describe, expect, it } from "vitest";
import { buildWrappedUsdcUnwrapPlan, buildWrappedUsdcWrapPlan } from "./token-wrap-transaction";

const circleDevnetUsdc = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const wrappedUsdc = "8wZmMHQY3bCJMhWs8j6BLxvgNLUkCXB2F5tEZPFF8A6q";
const tokenWrapProgram = "58yEtWEhrsRery3w1kZiTXdWofY6efvxmeAZwLrexgQ";
const contributor = "11111111111111111111111111111111";


const reserve = "Stake11111111111111111111111111111111111111";

describe("ordinary-USDC to Reserve wrapped-USDC transaction", () => {
  it("builds the maintained SDK wrap ABI directly into the deterministic Reserve Token-2022 account", async () => {
    const [expectedReserveTokenAccount] = await findAssociatedTokenPda({
      owner: address(reserve),
      mint: address(wrappedUsdc),
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS
    });
    const result = await buildWrappedUsdcWrapPlan({
      ownerAddress: contributor,
      reserveAddress: reserve,
      reserveTokenAccountAddress: expectedReserveTokenAccount,
      wrappedMintAddress: wrappedUsdc,
      unwrappedMintAddress: circleDevnetUsdc,
      tokenWrapProgramAddress: tokenWrapProgram,
      amount: 1_250_000n
    });
    const [expectedSource] = await findAssociatedTokenPda({
      owner: address(contributor),
      mint: address(circleDevnetUsdc),
      tokenProgram: TOKEN_PROGRAM_ADDRESS
    });
    const plan = result.plan as unknown as {
      kind: string;
      planType: string;
      divisible: boolean;
      plans: Array<{
        instruction: {
          programAddress: string;
          data: Uint8Array;
          accounts: Array<{ address: string }>;
        };
      }>;
    };
    const wrapInstruction = plan.plans[1].instruction;

    expect(plan).toMatchObject({
      kind: "sequential",
      planType: "instructionPlan",
      divisible: false,
      plans: [
        { instruction: { programAddress: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL" } },
        { instruction: { programAddress: tokenWrapProgram } }
      ]
    });
    expect(result.sourceTokenAccount).toBe(expectedSource);
    expect(result.destinationTokenAccount).toBe(expectedReserveTokenAccount);
    expect(wrapInstruction.data.byteLength).toBeGreaterThan(0);
    expect(wrapInstruction.accounts.map(({ address }) => address)).toEqual(
      expect.arrayContaining([
        expectedReserveTokenAccount,
        wrappedUsdc,
        result.wrappedMintAuthority,
        TOKEN_PROGRAM_ADDRESS,
        TOKEN_2022_PROGRAM_ADDRESS,
        expectedSource,
        circleDevnetUsdc,
        result.unwrappedEscrow,
        contributor
      ])
    );
    expect(result.expectedWrappedMintAddress).toBe(wrappedUsdc);
  });

  it("rejects an arbitrary wrapped-token destination before a transaction is submitted", async () => {
    await expect(
      buildWrappedUsdcWrapPlan({
        ownerAddress: contributor,
        reserveAddress: reserve,
        reserveTokenAccountAddress: contributor,
        wrappedMintAddress: wrappedUsdc,
        unwrappedMintAddress: circleDevnetUsdc,
        tokenWrapProgramAddress: tokenWrapProgram,
        amount: 1n
      })
    ).rejects.toThrow("deterministic wrapped-USDC Token-2022 account");
  });

  it("rejects a wrapped mint that does not derive from the configured Circle mint", async () => {
    await expect(
      buildWrappedUsdcWrapPlan({
        ownerAddress: contributor,
        reserveAddress: reserve,
        reserveTokenAccountAddress: contributor,
        wrappedMintAddress: contributor,
        unwrappedMintAddress: circleDevnetUsdc,
        tokenWrapProgramAddress: tokenWrapProgram,
        amount: 1n
      })
    ).rejects.toThrow("does not derive");
  });

  it.each([0n, -1n, (1n << 64n)])(
    "rejects an invalid wrap base-unit amount: %s",
    async (amount) => {
      const [reserveTokenAccountAddress] = await findAssociatedTokenPda({
        owner: address(reserve),
        mint: address(wrappedUsdc),
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS
      });
      await expect(
        buildWrappedUsdcWrapPlan({
          ownerAddress: contributor,
          reserveAddress: reserve,
          reserveTokenAccountAddress,
          wrappedMintAddress: wrappedUsdc,
          unwrappedMintAddress: circleDevnetUsdc,
          tokenWrapProgramAddress: tokenWrapProgram,
          amount
        })
      ).rejects.toThrow("positive u64");
    }
  );
});

describe("wrapped-USDC unwrap transaction", () => {
  it("builds the maintained SDK unwrap ABI for the deployed Devnet program and deterministic destination", async () => {
    const result = await buildWrappedUsdcUnwrapPlan({
      ownerAddress: contributor,
      wrappedMintAddress: wrappedUsdc,
      unwrappedMintAddress: circleDevnetUsdc,
      tokenWrapProgramAddress: tokenWrapProgram,
      amount: 1_250_000n
    });

    const [expectedDestination] = await findAssociatedTokenPda({
      owner: address(contributor),
      mint: address(circleDevnetUsdc),
      tokenProgram: TOKEN_PROGRAM_ADDRESS
    });
    const plan = result.plan as unknown as {
      kind: string;
      planType: string;
      divisible: boolean;
      plans: Array<{
        instruction: {
          programAddress: string;
          data: Uint8Array;
          accounts: Array<{ address: string }>;
        };
      }>;
    };
    const unwrapInstruction = plan.plans[1].instruction;

    expect(plan).toMatchObject({
      kind: "sequential",
      planType: "instructionPlan",
      divisible: false,
      plans: [
        {
          instruction: {
            programAddress: "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
          }
        },
        {
          instruction: {
            programAddress: tokenWrapProgram
          }
        }
      ]
    });
    expect(result.destinationTokenAccount).toBe(expectedDestination);
    expect(unwrapInstruction.data.byteLength).toBeGreaterThan(0);
    expect(unwrapInstruction.accounts.map(({ address }) => address)).toEqual(
      expect.arrayContaining([
        result.unwrappedEscrow,
        expectedDestination,
        result.wrappedMintAuthority,
        circleDevnetUsdc,
        TOKEN_2022_PROGRAM_ADDRESS,
        TOKEN_PROGRAM_ADDRESS,
        result.sourceTokenAccount,
        wrappedUsdc,
        contributor
      ])
    );
    expect(result.sourceTokenAccount).not.toBe(result.destinationTokenAccount);
    expect(result.expectedWrappedMintAddress).toBe(wrappedUsdc);
  });

  it("rejects a wrapped mint that does not derive from the configured Circle mint", async () => {
    await expect(
      buildWrappedUsdcUnwrapPlan({
        ownerAddress: contributor,
        wrappedMintAddress: contributor,
        unwrappedMintAddress: circleDevnetUsdc,
        tokenWrapProgramAddress: tokenWrapProgram,
        amount: 1n
      })
    ).rejects.toThrow("does not derive");
  });

  it.each([0n, -1n, (1n << 64n)])(
    "rejects an invalid unwrap base-unit amount: %s",
    async (amount) => {
      await expect(
        buildWrappedUsdcUnwrapPlan({
          ownerAddress: contributor,
          wrappedMintAddress: wrappedUsdc,
          unwrappedMintAddress: circleDevnetUsdc,
          tokenWrapProgramAddress: tokenWrapProgram,
          amount
        })
      ).rejects.toThrow("positive u64");
    }
  );
});
