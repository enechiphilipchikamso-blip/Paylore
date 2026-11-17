/**
 * Pure presentation rules for a contributor's payroll allocations, kept apart
 * from the component so the claim/cash-out surface can be tested without a DOM.
 */
export type ContributorAllocationView = {
  status: string;
  amountBaseUnits: string;
  claimAddress: string | null;
  transactionSignature: string | null;
};

export type AllocationTone = "success" | "partial" | "error" | "neutral";

/** Statuses the claim route can still settle. Anything else is terminal or not payable yet. */
export function isClaimableAllocation(status: string): boolean {
  return status === "unclaimed" || status === "settlement_pending";
}

export function describeContributorAllocation(allocation: ContributorAllocationView): {
  label: string;
  tone: AllocationTone;
  detail: string;
} {
  const claimCreated = Boolean(allocation.claimAddress && allocation.transactionSignature);
  switch (allocation.status) {
    case "draft":
      return {
        label: "Awaiting commitment",
        tone: "neutral",
        detail: "Your administrator has not finished committing this payroll run on Solana yet."
      };
    case "unclaimed":
      return claimCreated
        ? { label: "Ready to claim", tone: "partial", detail: "Unclaimed — no transfer recorded" }
        : {
            label: "Awaiting commitment",
            tone: "neutral",
            detail: "No finalized Claim account is recorded yet, so this cannot be claimed."
          };
    case "settlement_pending":
      return { label: "Settlement pending", tone: "partial", detail: "Settlement pending" };
    case "claimed":
      return { label: "Settled", tone: "success", detail: "Settled" };
    case "recovery_pending":
      return {
        label: "Recovery pending",
        tone: "partial",
        detail: "Your administrator is recovering this allocation."
      };
    case "recovered":
      return { label: "Recovered", tone: "neutral", detail: "Recovered" };
    case "cancelled":
      return {
        label: "Cancelled",
        tone: "error",
        detail: "This allocation was cancelled and is not payable."
      };
    default:
      return {
        label: allocation.status.replaceAll("_", " "),
        tone: "neutral",
        detail: allocation.status.replaceAll("_", " ")
      };
  }
}

export function summarizeContributorAllocations(
  allocations: ReadonlyArray<Pick<ContributorAllocationView, "status" | "amountBaseUnits">>
): {
  claimableCount: number;
  claimableBaseUnits: bigint;
  settledCount: number;
  settledBaseUnits: bigint;
  recoveredCount: number;
  recoveredBaseUnits: bigint;
} {
  const summary = {
    claimableCount: 0,
    claimableBaseUnits: 0n,
    settledCount: 0,
    settledBaseUnits: 0n,
    recoveredCount: 0,
    recoveredBaseUnits: 0n
  };
  for (const allocation of allocations) {
    if (!/^(0|[1-9][0-9]*)$/.test(allocation.amountBaseUnits)) continue;
    const amount = BigInt(allocation.amountBaseUnits);
    if (isClaimableAllocation(allocation.status)) {
      summary.claimableCount += 1;
      summary.claimableBaseUnits += amount;
    } else if (allocation.status === "claimed") {
      summary.settledCount += 1;
      summary.settledBaseUnits += amount;
    } else if (allocation.status === "recovered") {
      summary.recoveredCount += 1;
      summary.recoveredBaseUnits += amount;
    }
  }
  return summary;
}

export function shortReference(value: string): string {
  return value.length > 20 ? `${value.slice(0, 8)}…${value.slice(-8)}` : value;
}

/**
 * Why an amount cannot be submitted yet, or null when it can. Mirrors the
 * checks the withdrawal handler enforces so the contributor sees the reason
 * before pressing the button instead of after a wallet prompt.
 */
export function describeAmountIssue(input: {
  rawAmount: string;
  maxBaseUnits: bigint;
  maxLabel: string;
}): string | null {
  const value = input.rawAmount.trim();
  if (value === "") return null;
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) {
    return "Enter a positive USDC amount with up to six decimal places.";
  }
  const [whole = "0", fraction = ""] = value.split(".");
  const amount = BigInt(whole) * 1_000_000n + BigInt((fraction + "000000").slice(0, 6));
  if (amount <= 0n) return "Enter an amount greater than zero.";
  if (amount > input.maxBaseUnits) return `That is more than your ${input.maxLabel}.`;
  return null;
}
