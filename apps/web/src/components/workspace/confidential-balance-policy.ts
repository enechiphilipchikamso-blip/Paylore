export function assertConfidentialWithdrawalAvailable(input: {
  amountBaseUnits: bigint;
  availableBalance: bigint;
  pendingBalance: bigint;
}): void {
  if (input.amountBaseUnits <= 0n) {
    throw new Error("Enter a positive USDC amount.");
  }
  if (input.pendingBalance < 0n || input.availableBalance < 0n) {
    throw new Error("The confidential balance could not be verified. Refresh before withdrawing.");
  }
  if (input.pendingBalance > 0n) {
    throw new Error("Apply pending confidential credits before withdrawing. Pending funds are not spendable until applied.");
  }
  if (input.amountBaseUnits > input.availableBalance) {
    throw new Error("The requested amount is greater than the available confidential balance.");
  }
}
