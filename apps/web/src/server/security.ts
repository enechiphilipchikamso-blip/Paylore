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

function codespacesOrigin(
  value: string
): string | null {
  const codespaceName =
    process.env.CODESPACE_NAME;

  if (
    process.env.NODE_ENV === "production" ||
    !codespaceName
  ) {
    return null;
  }

  try {
    const url = new URL(value);
    const escapedName =
      codespaceName.replace(
        /[.*+?^${}()|[\]\\]/g,
        "\\$&"
      );

    return (
      url.protocol === "https:" &&
      new RegExp(
        `^${escapedName}-\\d+\\.app\\.github\\.dev$`
      ).test(url.hostname)
    )
      ? url.origin
      : null;
  } catch {
    return null;
  }
}

function codespacesFallbackOrigin(): string | null {
  const codespaceName =
    process.env.CODESPACE_NAME;

  if (
    process.env.NODE_ENV === "production" ||
    !codespaceName
  ) {
    return null;
  }

  const port =
    process.env.PORT || "3000";

  if (!/^\d{1,5}$/.test(port)) {
    return null;
  }

  return codespacesOrigin(
    `https://${codespaceName}-${port}.app.github.dev`
  );
}

function isLoopbackOrigin(
  value: string
): boolean {
  try {
    const url = new URL(value);

    return (
      (url.protocol === "http:" ||
        url.protocol === "https:") &&
      (url.hostname === "localhost" ||
        url.hostname === "127.0.0.1" ||
        url.hostname === "[::1]")
    );
  } catch {
    return false;
  }
}

function isDevelopmentLoopbackProxyOrigin(
  origin: string,
  expectedOrigin: string,
  request: Request
): boolean {
  if (
    process.env.NODE_ENV === "production" ||
    !isLoopbackOrigin(origin)
  ) {
    return false;
  }

  const originUrl = new URL(origin);
  if (
    originUrl.port !==
    (process.env.PORT || "3000")
  ) {
    return false;
  }

  const forwardedHost =
    request.headers.get(
      "x-forwarded-host"
    );
  const forwardedProto =
    request.headers.get(
      "x-forwarded-proto"
    );

  if (
    !forwardedHost ||
    !forwardedProto ||
    forwardedHost.includes(",") ||
    forwardedProto.includes(",") ||
    (forwardedProto !== "http" &&
      forwardedProto !== "https")
  ) {
    return false;
  }

  try {
    return (
      new URL(
        `${forwardedProto}://${forwardedHost}`
      ).origin === expectedOrigin
    );
  } catch {
    return false;
  }
}

export function getRequestOrigin(
  request: Request
): string {
  const forwardedHost =
    request.headers.get(
      "x-forwarded-host"
    );
  const forwardedProto =
    request.headers.get(
      "x-forwarded-proto"
    );

  let forwardedOrigin: string | null = null;
  if (
    forwardedHost &&
    forwardedProto &&
    !forwardedHost.includes(",") &&
    !forwardedProto.includes(",") &&
    (forwardedProto === "http" ||
      forwardedProto === "https")
  ) {
    try {
      const forwardedUrl =
        new URL(
          `${forwardedProto}://${forwardedHost}`
        );

      if (
        forwardedUrl.username ||
        forwardedUrl.password ||
        forwardedUrl.pathname !== "/" ||
        forwardedUrl.search ||
        forwardedUrl.hash
      ) {
        throw new Error(
          "Invalid forwarded origin."
        );
      }

      forwardedOrigin =
        forwardedUrl.origin;
    } catch {
      throw new RequestSecurityError(
        "Invalid forwarded origin."
      );
    }
  }

  const requestOrigin =
    new URL(request.url).origin;
  const fallbackOrigin =
    codespacesFallbackOrigin();

  if (fallbackOrigin) {
    const trustedCodespacesOrigins = [
      forwardedOrigin,
      request.headers.get("origin"),
      request.headers.get("referer"),
      requestOrigin
    ]
      .filter(
        (value): value is string =>
          Boolean(value)
      )
      .map(codespacesOrigin)
      .find(
        (value): value is string =>
          value !== null
      );

    return (
      trustedCodespacesOrigins ??
      fallbackOrigin
    );
  }

  return (
    forwardedOrigin ??
    requestOrigin
  );
}

export function assertSameOrigin(
  request: Request
): void {
  const expectedOrigin =
    getRequestOrigin(request);

  const origin =
    request.headers.get("origin");

  if (origin) {
    if (origin !== expectedOrigin) {
      const requestOrigin =
        new URL(request.url).origin;

      if (
        process.env.NODE_ENV !== "production" &&
        origin === requestOrigin &&
        isLoopbackOrigin(origin)
      ) {
        return;
      }

      if (
        isDevelopmentLoopbackProxyOrigin(
          origin,
          expectedOrigin,
          request
        )
      ) {
        return;
      }

      if (codespacesOrigin(origin)) {
        return;
      }

      throw new RequestSecurityError(
        `Origin does not match the app origin (${origin} != ${expectedOrigin}).`
      );
    }

    return;
  }

  const referer =
    request.headers.get("referer");

  if (referer) {
    let refererOrigin: string;

    try {
      refererOrigin =
        new URL(referer).origin;
    } catch {
      throw new RequestSecurityError(
        "Invalid Referer header."
      );
    }

    if (refererOrigin !== expectedOrigin) {
      if (codespacesOrigin(refererOrigin)) {
        return;
      }

      throw new RequestSecurityError(
        `Referer does not match the app origin (${refererOrigin} != ${expectedOrigin}).`
      );
    }

    return;
  }

  if (
    request.headers.get("sec-fetch-site") ===
    "same-origin"
  ) {
    return;
  }

  if (
    process.env.NODE_ENV !== "production" &&
    codespacesFallbackOrigin() &&
    !request.headers.get("sec-fetch-site") &&
    request.headers
      .get("content-type")
      ?.split(";")[0]
      .trim()
      .toLowerCase() === "application/json"
  ) {
    return;
  }

  throw new RequestSecurityError(
    "No same-origin request metadata was provided."
  );
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