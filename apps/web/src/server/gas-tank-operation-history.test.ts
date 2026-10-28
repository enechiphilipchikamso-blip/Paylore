import { describe, expect, it } from "vitest";
import {
  operationDataForGasTankRetry,
  readGasTankSponsorshipAttempts,
  summarizeGasTankSponsorshipBudget
} from "@paylore/database";

const now = new Date("2026-10-22T10:00:00.000Z");
const since = new Date(now.getTime() - 24 * 60 * 60 * 1000);

function failedAttempt(signature: string, feeLamports: string, recordedAt: Date) {
  return {
    status: "failed" as const,
    transactionSignature: signature,
    feeLamports,
    failureCode: "finalized_chain_failure" as const,
    recordedAt: recordedAt.toISOString()
  };
}

describe("Gas Tank sponsorship retry accounting", () => {
  it("preserves a finalized chain failure's actual fee and signature when a retry reuses its operation row", () => {
    const previous = {
      status: "failed",
      transactionSignature: "chain-failure-signature",
      feeLamports: "7000",
      failureCode: "finalized_chain_failure",
      updatedAt: new Date("2026-10-22T09:45:00.000Z"),
      operationData: {
        runId: "run-a",
        transactionBase64: "old-wire-transaction",
        sponsorshipAttempts: [
          failedAttempt("older-in-window", "6000", new Date("2026-10-21T11:00:00.000Z")),
          failedAttempt("outside-window", "9000", new Date("2026-10-20T08:00:00.000Z"))
        ]
      }
    };

    const next = operationDataForGasTankRetry({
      nextOperationData: { runId: "run-a", claimIds: ["claim-a"] },
      previousOperation: previous,
      since
    });

    expect(next).toMatchObject({
      runId: "run-a",
      claimIds: ["claim-a"],
      sponsorshipAttempts: [
        failedAttempt("older-in-window", "6000", new Date("2026-10-21T11:00:00.000Z")),
        failedAttempt("chain-failure-signature", "7000", new Date("2026-10-22T09:45:00.000Z"))
      ]
    });
    expect(next).not.toHaveProperty("transactionBase64");
  });

  it("keeps previous failed fees in the rolling budget while a replacement is preparing", () => {
    const usage = summarizeGasTankSponsorshipBudget({
      since,
      reservedFeeLamports: "100000",
      rows: [{
        status: "preparing",
        feeLamports: "100000",
        failureCode: null,
        operationData: {
          sponsorshipAttempts: [
            failedAttempt("failed-a", "7000", new Date("2026-10-22T08:30:00.000Z")),
            failedAttempt("failed-b", "8000", new Date("2026-10-22T09:00:00.000Z"))
          ]
        }
      }]
    });

    expect(usage).toEqual({
      feeLamports: 115000n,
      operationCount: 3,
      reservedFeesLamports: 100000n,
      overflow: false
    });
  });

  it("does not count attempts outside the rolling window or non-chain cancellations", () => {
    const usage = summarizeGasTankSponsorshipBudget({
      since,
      reservedFeeLamports: "100000",
      rows: [{
        status: "cancelled",
        feeLamports: "0",
        failureCode: "recent_blockhash_expired",
        operationData: {
          sponsorshipAttempts: [
            failedAttempt("old-failure", "7000", new Date("2026-10-20T08:00:00.000Z"))
          ]
        }
      }]
    });

    expect(usage).toEqual({
      feeLamports: 0n,
      operationCount: 0,
      reservedFeesLamports: 0n,
      overflow: false
    });
  });

  it("fails closed when persisted fee-bearing history loses a required field", () => {
    expect(() => readGasTankSponsorshipAttempts({
      sponsorshipAttempts: [{
        status: "failed",
        failureCode: "finalized_chain_failure",
        transactionSignature: "chain-failure-signature",
        feeLamports: null,
        recordedAt: now.toISOString()
      }]
    })).toThrow("Invalid persisted Gas Tank sponsorship attempt history.");
  });

  it("fails closed when the current finalized failure has no fee evidence", () => {
    expect(() => summarizeGasTankSponsorshipBudget({
      since,
      reservedFeeLamports: "100000",
      rows: [{
        status: "failed",
        feeLamports: null,
        failureCode: "finalized_chain_failure",
        operationData: {}
      }]
    })).toThrow("Persisted Gas Tank operation is missing valid fee evidence.");
  });
});
