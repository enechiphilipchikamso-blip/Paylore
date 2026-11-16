/**
 * Text that wallets and RPC providers return when they have nothing useful to
 * say (JSON-RPC -32603 is literally "Internal error"). Paylore never writes
 * these strings itself, so seeing one means the provider hid the real reason.
 */
const GENERIC_PROVIDER_TEXT =
  /^(?:an? )?(?:internal(?: json-?rpc)? error|unexpected error|unknown error|something went wrong|an unexpected error occurred|error)\.?$/i;

function messageOf(value: unknown): string {
  if (value instanceof Error) return value.message.trim();
  if (typeof value === "string") return value.trim();
  if (value && typeof value === "object" && "message" in value && typeof value.message === "string") {
    return value.message.trim();
  }
  return "";
}

export function describeClientError(
  error: unknown,
  operation: string,
  fallback: string
): string {
  const reason = messageOf(error);
  const cause = error instanceof Error ? messageOf(error.cause) : "";
  const detail = GENERIC_PROVIDER_TEXT.test(reason) && cause && !GENERIC_PROVIDER_TEXT.test(cause)
    ? cause
    : reason;

  if (!detail) return `${operation} failed: ${fallback}`;
  if (GENERIC_PROVIDER_TEXT.test(detail)) {
    return `${operation} failed: the provider returned only "${detail}". Check the connection and current operation status before retrying.`;
  }
  const boundedDetail = detail.length > 500 ? `${detail.slice(0, 497)}...` : detail;
  return `${operation} failed: ${boundedDetail}`;
}
