export type ClaimAndCashOutSetupOutcome =
  | "account_already_ready"
  | "account_setup_completed"
  | "account_setup_incomplete";

/** Keeps account preparation lazy and prevents settlement from advancing after failed setup. */
export async function ensureClaimAndCashOutAccount(input: {
  accountReady: boolean;
  setupAccount: () => Promise<boolean>;
}): Promise<ClaimAndCashOutSetupOutcome> {
  if (input.accountReady) return "account_already_ready";
  return await input.setupAccount()
    ? "account_setup_completed"
    : "account_setup_incomplete";
}
