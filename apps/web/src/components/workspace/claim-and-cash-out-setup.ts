export type ClaimAndCashOutSetupOutcome =
  | "settlement_unavailable"
  | "account_setup_completed"
  | "account_setup_incomplete";

/** First-use claim entry points must prepare the contributor-owned account before later settlement can proceed. */
export async function ensureClaimAndCashOutAccount(input: {
  accountReady: boolean;
  setupAccount: () => Promise<boolean>;
}): Promise<ClaimAndCashOutSetupOutcome> {
  if (input.accountReady) return "settlement_unavailable";
  return await input.setupAccount()
    ? "account_setup_completed"
    : "account_setup_incomplete";
}
