import { describe, expect, it } from "vitest";
import { buildWrappedUsdcUnwrapPlan } from "./token-wrap-transaction";

const circleDevnetUsdc = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const wrappedUsdc = "8wZmMHQY3bCJMhWs8j6BLxvgNLUkCXB2F5tEZPFF8A6q";
const tokenWrapProgram = "58yEtWEhrsRery3w1kZiTXdWofY6efvxmeAZwLrexgQ";
const contributor = "11111111111111111111111111111111";

describe("wrapped-USDC unwrap transaction", () => {
  it("builds an atomic custom Token Wrap unwrap to the contributor's Circle-USDC ATA", async () => {
    const result = await buildWrappedUsdcUnwrapPlan({
      ownerAddress: contributor,
      wrappedMintAddress: wrappedUsdc,
      unwrappedMintAddress: circleDevnetUsdc,
      tokenWrapProgramAddress: tokenWrapProgram,
      amount: 1_250_000n
    });

    expect(result.plan).toMatchObject({
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
    expect(result.sourceTokenAccount).not.toBe(result.destinationTokenAccount);
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
