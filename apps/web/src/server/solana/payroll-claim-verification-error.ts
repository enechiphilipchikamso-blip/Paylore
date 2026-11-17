/**
 * Raised when finalized on-chain evidence disagrees with the approved payroll
 * (wrong instruction, wrong Claim PDA, wrong state). Unlike an RPC or network
 * failure, retrying cannot make it succeed, so callers map it to a terminal
 * "could not be verified" outcome instead of a retryable server error.
 */
export class PayrollClaimVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayrollClaimVerificationError";
  }
}
