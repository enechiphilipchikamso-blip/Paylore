export type ConfidentialAccountClosureEvidence = {
  connectedWalletAddress: string;
  ownerWalletAddress: string;
  accountStatus: string | null;
  publicBalance: bigint | null;
  pendingBalance: bigint | null;
  availableBalance: bigint | null;
  hasOpenAllocations: boolean;
};

export type ConfidentialAccountClosureBlocker =
  | "confidential_account_owner_mismatch"
  | "confidential_account_not_ready"
  | "outstanding_compensation_obligation"
  | "confidential_balance_unavailable"
  | "confidential_account_balance_not_zero";

export function getConfidentialAccountClosureBlocker(
  evidence: ConfidentialAccountClosureEvidence
): ConfidentialAccountClosureBlocker | null {
  if (!evidence.connectedWalletAddress || evidence.connectedWalletAddress !== evidence.ownerWalletAddress) {
    return "confidential_account_owner_mismatch";
  }
  if (evidence.accountStatus !== "ready") return "confidential_account_not_ready";
  if (evidence.hasOpenAllocations) return "outstanding_compensation_obligation";
  const balances = [evidence.publicBalance, evidence.pendingBalance, evidence.availableBalance];
  if (balances.some((balance) => typeof balance !== "bigint" || balance < 0n)) {
    return "confidential_balance_unavailable";
  }
  if (balances.some((balance) => balance !== 0n)) return "confidential_account_balance_not_zero";
  return null;
}
