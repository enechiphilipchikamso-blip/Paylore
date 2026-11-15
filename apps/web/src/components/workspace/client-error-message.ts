export function describeClientError(
  error: unknown,
  operation: string,
  fallback: string
): string {
  const reason = error instanceof Error ? error.message.trim() : "";
  const rawCause = error instanceof Error ? error.cause : null;
  const cause = rawCause instanceof Error
    ? rawCause.message.trim()
    : typeof rawCause === "string"
      ? rawCause.trim()
    : "";
  const detail = /^(internal error|something went wrong)$/i.test(reason) && cause
    ? cause
    : reason;

  if (!detail) return `${operation} failed: ${fallback}`;
  if (/^(internal error|something went wrong)$/i.test(detail)) {
    return `${operation} failed: the provider returned only "${detail}". Check the connection and current operation status before retrying.`;
  }
  const boundedDetail = detail.length > 500 ? `${detail.slice(0, 497)}...` : detail;
  return `${operation} failed: ${boundedDetail}`;
}
