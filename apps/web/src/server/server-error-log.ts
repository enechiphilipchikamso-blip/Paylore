/**
 * Structured, secret-safe failure logging for API routes.
 *
 * Routes used to log only an event name before returning a generic error code,
 * so an operator reading the host's function log could not tell a missing
 * environment value from an RPC outage or a database error. This records the
 * error class, its code, and a bounded, redacted message and cause.
 *
 * Redaction is deliberately blunt: URLs (providers embed API keys in them) and
 * credential-looking `key=value` pairs are removed before anything is written.
 * Private keys, request bodies and wallet signatures are never passed in.
 */
const MAX_LOGGED_TEXT_LENGTH = 300;

function redact(text: string): string {
  return text
    .replace(/https?:\/\/[^\s"')]+/gi, "[url]")
    .replace(
      /\b(api[-_]?key|apikey|token|secret|authorization|password)(["']?\s*[:=]\s*["']?)(?:Bearer\s+)?[^\s"'&,;]+/gi,
      "$1$2[redacted]"
    )
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, MAX_LOGGED_TEXT_LENGTH);
}

export type FailureLogDetails = {
  errorName: string;
  errorCode?: string;
  errorMessage: string;
  causeMessage?: string;
};

export function describeFailureForLog(error: unknown): FailureLogDetails {
  if (error instanceof Error) {
    const record = error as Error & {
      code?: unknown;
      __code?: unknown;
      cause?: unknown;
    };
    const code = typeof record.code === "string"
      ? record.code
      : typeof record.__code === "number"
        ? String(record.__code)
        : undefined;
    const cause = record.cause instanceof Error
      ? record.cause.message
      : typeof record.cause === "string"
        ? record.cause
        : undefined;
    return {
      errorName: error.name,
      ...(code ? { errorCode: redact(code) } : {}),
      errorMessage: redact(error.message),
      ...(cause ? { causeMessage: redact(cause) } : {})
    };
  }
  return {
    errorName: typeof error,
    errorMessage: typeof error === "string"
      ? redact(error)
      : "A non-Error value was thrown."
  };
}

/**
 * Records an expected, typed rejection (for example a 409 `gas_tank_insufficient_balance`).
 * These are not exceptions, but without a line an operator cannot tell which rule
 * stopped a request that the browser reports only as a status code.
 */
export function logServerRejection(
  event: string,
  code: string,
  status: number,
  context: Record<string, string | number | boolean | null> = {}
): void {
  console.warn(JSON.stringify({ event, errorCode: code, status, ...context }));
}

/** Writes one JSON line: the event, small identifying context, and the redacted failure. */
export function logServerFailure(
  event: string,
  error: unknown,
  context: Record<string, string | number | boolean | null> = {}
): void {
  console.error(
    JSON.stringify({ event, ...context, ...describeFailureForLog(error) })
  );
}
