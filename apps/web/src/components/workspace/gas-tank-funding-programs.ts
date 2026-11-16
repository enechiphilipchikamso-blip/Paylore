/**
 * Programs a wallet may add around the reviewed Gas Tank funding transfer
 * without changing what the transfer does.
 *
 * Wallets commonly wrap a signed transaction with priority-fee instructions
 * (Compute Budget) or with transaction-guard assertions (Lighthouse). Neither
 * can move SOL between the payer and the Gas Tank, so they are accepted next to
 * exactly one System Program transfer that still matches the reviewed payer,
 * Gas Tank address and amount. Any other program is refused.
 *
 * This module has no dependencies so both the browser review step, the server
 * submission check and the post-landing verification can share one allowlist.
 */
export const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
export const COMPUTE_BUDGET_PROGRAM_ID =
  "ComputeBudget111111111111111111111111111111";
export const LIGHTHOUSE_PROGRAM_ID =
  "L2TExMFKdjpN9kozasaurPirfHy9P8sbXoAN1qA3Ugs";

export const GAS_TANK_FUNDING_ALLOWED_EXTRA_PROGRAM_IDS: ReadonlySet<string> =
  new Set([COMPUTE_BUDGET_PROGRAM_ID, LIGHTHOUSE_PROGRAM_ID]);

/** A wallet-added instruction set larger than this is treated as a different transaction. */
export const GAS_TANK_FUNDING_MAX_INSTRUCTIONS = 8;

/** Solana's serialized transaction limit; a larger payload cannot be a valid transfer. */
export const SOLANA_MAX_TRANSACTION_BYTES = 1_232;
