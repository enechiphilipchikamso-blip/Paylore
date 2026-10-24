import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPayrollClaimTransactions } from "./payroll-program-transaction";

const workspaceId = "5f7bbaf7-21ab-4e62-95be-84f5d6bf6bb3";
const programId = "4zYM9ZjwbAz9jxQ2C69Z83n1s4wceCPk7VzDLKoUnT93";
const authorityAddress = "Vote111111111111111111111111111111111111111";
const contributorAddress = "11111111111111111111111111111111";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("payroll program transactions", () => {
  it("rejects invalid claim IDs before contacting the Devnet RPC", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      buildPayrollClaimTransactions({
        authorityAddress,
        workspaceId,
        allocationCommitment: "a".repeat(64),
        claims: [
          {
            claimId: "invalid",
            contributorAddress: "11111111111111111111111111111111",
            amountCommitment: "cd".repeat(32)
          }
        ],
        programId,
        includeWorkspaceInitialization: true
      })
    ).rejects.toThrow("Claim identifier must be a 32-byte hexadecimal value.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("includes workspace initialization and separates large claim sets into bounded transactions", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          result: {
            context: { slot: 42 },
            value: {
              blockhash: "11111111111111111111111111111111",
              lastValidBlockHeight: 100
            }
          }
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const transactions = await buildPayrollClaimTransactions({
      authorityAddress,
      workspaceId,
      allocationCommitment: "ab".repeat(32),
      claims: Array.from({ length: 5 }, (_, index) => ({
        claimId: index.toString(16).padStart(2, "0").repeat(32),
        amountCommitment: "cd".repeat(32),
        contributorAddress: [
          "11111111111111111111111111111111",
          "Vote111111111111111111111111111111111111111",
          "SysvarRent111111111111111111111111111111111",
          "Stake11111111111111111111111111111111111111",
          "ComputeBudget111111111111111111111111111111"
        ][index]!
      })),
      programId,
      includeWorkspaceInitialization: true
    });

    expect(transactions).toHaveLength(2);
    expect(transactions[0]?.claimIds).toHaveLength(4);
    expect(transactions[1]?.claimIds).toHaveLength(1);
    expect(transactions[0]?.transaction.length).toBeGreaterThan(100);
    expect(transactions[1]?.transaction.length).toBeGreaterThan(100);
    expect(transactions.every((transaction) => transaction.transaction.length <= 1232)).toBe(true);
    expect(transactions.flatMap((transaction) => transaction.claimIds)).toHaveLength(5);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects duplicate claim identifiers", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      buildPayrollClaimTransactions({
        authorityAddress,
        workspaceId,
        allocationCommitment: "ab".repeat(32),
        claims: [
          {
            claimId: "01".repeat(32),
            amountCommitment: "cd".repeat(32),
            contributorAddress: "Vote111111111111111111111111111111111111111"
          },
          {
            claimId: "01".repeat(32),
            amountCommitment: "cd".repeat(32),
            contributorAddress: "11111111111111111111111111111111"
          }
        ],
        programId,
        includeWorkspaceInitialization: false
      })
    ).rejects.toThrow("Payroll claim identifiers must be unique.");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects duplicate contributors in one payroll run", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      buildPayrollClaimTransactions({
        authorityAddress,
        workspaceId,
        allocationCommitment: "ab".repeat(32),
        claims: [
          {
            claimId: "01".repeat(32),
            amountCommitment: "cd".repeat(32),
            contributorAddress
          },
          {
            claimId: "02".repeat(32),
            amountCommitment: "cd".repeat(32),
            contributorAddress
          }
        ],
        programId,
        includeWorkspaceInitialization: false
      })
    ).rejects.toThrow("A payroll run can include each contributor only once.");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
