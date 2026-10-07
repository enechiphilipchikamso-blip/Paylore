export function isWalletCancellation(
  cause: unknown
): boolean {
  if (!(cause instanceof Error)) {
    return false;
  }

  if (
    cause.name === "AbortError" ||
    cause.name === "UserRejectedRequestError"
  ) {
    return true;
  }

  const code =
    "code" in cause
      ? cause.code
      : undefined;

  if (
    code === 4001 ||
    code === "4001" ||
    code === "ACTION_REJECTED"
  ) {
    return true;
  }

  return /\b(?:user (?:rejected|denied|canceled|cancelled)|(?:rejected|denied|canceled|cancelled) by user)\b/i.test(
    cause.message
  );
}
