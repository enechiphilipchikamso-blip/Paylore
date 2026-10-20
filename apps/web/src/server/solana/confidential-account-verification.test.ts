import { afterEach, describe, expect, it, vi } from "vitest";
import {
  findAssociatedTokenPda,
  TOKEN_2022_PROGRAM_ADDRESS
} from "@solana-program/token-2022";
import { address } from "@solana/kit";
import { readSolanaRpc } from "./rpc";
import {
  verifyConfidentialAccountClose,
  verifyConfidentialAccountSetup
} from "./confidential-account-verification";

vi.mock("./rpc", () => ({
  readSolanaRpc: vi.fn()
}));
vi.mock("server-only", () => ({}));

const walletAddress = address("11111111111111111111111111111111");
const mintAddress = address("Vote111111111111111111111111111111111111111");
const signature = "5".repeat(64);

async function expectedAccount() {
  const [tokenAccount] = await findAssociatedTokenPda({
    owner: walletAddress,
    mint: mintAddress,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS
  });
  return tokenAccount;
}

function finalizedTransaction(instruction: Record<string, unknown>) {
  return {
    slot: 42,
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: [walletAddress, mintAddress],
        instructions: [instruction]
      }
    },
    meta: { err: null }
  };
}

afterEach(() => {
  vi.resetAllMocks();
});

describe("confidential account transaction verification", () => {
  it("accepts finalized setup only for the owner's derived Token-2022 account", async () => {
    const tokenAccount = await expectedAccount();
    vi.mocked(readSolanaRpc)
      .mockResolvedValueOnce(
        finalizedTransaction({
          programId: TOKEN_2022_PROGRAM_ADDRESS,
          parsed: {
            type: "configureConfidentialTransferAccount",
            info: { token: tokenAccount, mint: mintAddress }
          }
        })
      )
      .mockResolvedValueOnce({
        value: {
          owner: TOKEN_2022_PROGRAM_ADDRESS,
          data: ["AQID", "base64"]
        }
      });

    await expect(verifyConfidentialAccountSetup({
      signature,
      walletAddress,
      mintAddress
    })).resolves.toBe(tokenAccount);
  });

  it("rejects missing or failed finalized transaction evidence", async () => {
    vi.mocked(readSolanaRpc).mockResolvedValue(null);
    await expect(verifyConfidentialAccountSetup({
      signature,
      walletAddress,
      mintAddress
    })).rejects.toThrow("not finalized successfully");

    vi.mocked(readSolanaRpc).mockResolvedValue(
      finalizedTransaction({
        programId: TOKEN_2022_PROGRAM_ADDRESS,
        parsed: {
          type: "configureConfidentialTransferAccount",
          info: { token: walletAddress, mint: mintAddress }
        }
      })
    );
    await expect(verifyConfidentialAccountSetup({
      signature,
      walletAddress,
      mintAddress
    })).rejects.toThrow("does not configure");
  });

  it("rejects setup when the derived Token-2022 account is absent", async () => {
    const tokenAccount = await expectedAccount();
    vi.mocked(readSolanaRpc)
      .mockResolvedValueOnce(
        finalizedTransaction({
          programId: TOKEN_2022_PROGRAM_ADDRESS,
          parsed: {
            type: "configureConfidentialTransferAccount",
            info: { token: tokenAccount, mint: mintAddress }
          }
        })
      )
      .mockResolvedValueOnce({ value: null });

    await expect(verifyConfidentialAccountSetup({
      signature,
      walletAddress,
      mintAddress
    })).rejects.toThrow("could not be reconciled");
  });

  it("accepts an account close only when rent returns to its owner", async () => {
    const tokenAccount = await expectedAccount();
    vi.mocked(readSolanaRpc)
      .mockResolvedValueOnce(finalizedTransaction({
        programId: TOKEN_2022_PROGRAM_ADDRESS,
        parsed: {
          type: "closeAccount",
          info: {
            account: tokenAccount,
            destination: walletAddress,
            owner: walletAddress
          }
        }
      }))
      .mockResolvedValueOnce({ value: null });
    await expect(verifyConfidentialAccountClose({
      signature,
      walletAddress,
      mintAddress
    })).resolves.toBe(tokenAccount);

    vi.mocked(readSolanaRpc).mockResolvedValue(
      finalizedTransaction({
        programId: TOKEN_2022_PROGRAM_ADDRESS,
        parsed: {
          type: "closeAccount",
          info: {
            account: tokenAccount,
            destination: mintAddress,
            owner: walletAddress
          }
        }
      })
    );
    await expect(verifyConfidentialAccountClose({
      signature,
      walletAddress,
      mintAddress
    })).rejects.toThrow("does not close");
  });

  it("rejects close confirmation if the token account still exists on-chain", async () => {
    const tokenAccount = await expectedAccount();
    vi.mocked(readSolanaRpc)
      .mockResolvedValueOnce(
        finalizedTransaction({
          programId: TOKEN_2022_PROGRAM_ADDRESS,
          parsed: {
            type: "closeAccount",
            info: {
              account: tokenAccount,
              destination: walletAddress,
              owner: walletAddress
            }
          }
        })
      )
      .mockResolvedValueOnce({
        value: { owner: TOKEN_2022_PROGRAM_ADDRESS }
      });

    await expect(verifyConfidentialAccountClose({
      signature,
      walletAddress,
      mintAddress
    })).rejects.toThrow("still exists");
  });
});
