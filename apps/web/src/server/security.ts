import { createHash } from "node:crypto";
import { address } from "@solana/kit";

export class RequestSecurityError extends Error {
  constructor(
    message =
      "Request security validation failed."
  ) {
    super(message);
    this.name =
      "RequestSecurityError";
  }
}

export function assertSameOrigin(
  request: Request
): void {
  const origin = request.headers.get(
    "origin"
  );

  if (!origin) {
    throw new RequestSecurityError(
      "Missing Origin header."
    );
  }

  const requestOrigin =
    new URL(request.url).origin;

  if (origin !== requestOrigin) {
    throw new RequestSecurityError(
      "Origin does not match request origin."
    );
  }
}

export function hashOpaqueToken(
  value: string
): string {
  return createHash("sha256")
    .update(value, "utf8")
    .digest("hex");
}

export function isSafeReturnTo(
  value: string | undefined,
  fallback = "/app"
): string {
  if (!value) {
    return fallback;
  }

  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\")
  ) {
    return fallback;
  }

  return value;
}

export function isValidSolanaAddress(
  value: string
): boolean {
  try {
    address(value);
    return true;
  } catch {
    return false;
  }
}