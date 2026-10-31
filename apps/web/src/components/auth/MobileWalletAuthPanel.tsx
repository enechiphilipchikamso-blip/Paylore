"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import {
  buildWalletConnectDeepLink,
  buildWalletSignMessageDeepLink,
  createWalletEncryptionKeyPair,
  decodeBase58,
  decryptWalletPayload,
  deriveWalletSharedSecret,
  encodeBase58,
  encryptWalletPayload,
  isValidWalletCallbackState,
  parseWalletError
} from "./mobile-wallet-deeplink";

const MOBILE_CONNECTION_KEY = "paylore:mobile-wallet:connection:v1";
const MOBILE_PENDING_PREFIX = "paylore:mobile-wallet:pending:v1:";
const MOBILE_PENDING_MAX_AGE_MS = 10 * 60 * 1000;
const MOBILE_SESSION_CHAIN = "solana:devnet";

type MobileWalletAccount = {
  address: string;
  publicKey: Uint8Array;
  chains: string[];
  features: string[];
};

type MobileConnection = {
  provider: "solflare";
  appUrl: string;
  dappPublicKey: string;
  dappSecretKey: string;
  walletEncryptionPublicKey: string;
  walletAddress: string;
  session: string;
  connectedAt: number;
};

type PendingConnect = {
  action: "connect";
  state: string;
  provider: "solflare";
  appUrl: string;
  dappPublicKey: string;
  dappSecretKey: string;
  createdAt: number;
};

type PendingSignMessage = {
  action: "sign_message";
  state: string;
  createdAt: number;
  challengeNonce: string;
  challengeMessage: string;
  walletAddress: string;
};

type ChallengeResponse = {
  nonce: string;
  input: unknown;
  message: string;
};

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function createState(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return [...bytes]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function getSessionStorage(): Storage {
  try {
    return window.sessionStorage;
  } catch {
    throw new Error(
      "This browser cannot keep a secure wallet connection open. Enable session storage and try again."
    );
  }
}

function readMobileConnection(): MobileConnection | null {
  try {
    const raw = getSessionStorage().getItem(MOBILE_CONNECTION_KEY);
    if (!raw) return null;
    const value = JSON.parse(raw) as MobileConnection;
    if (
      value.provider !== "solflare" ||
      typeof value.appUrl !== "string" ||
      typeof value.dappPublicKey !== "string" ||
      typeof value.dappSecretKey !== "string" ||
      typeof value.walletEncryptionPublicKey !== "string" ||
      typeof value.walletAddress !== "string" ||
      typeof value.session !== "string" ||
      !value.session ||
      typeof value.connectedAt !== "number"
    ) {
      getSessionStorage().removeItem(MOBILE_CONNECTION_KEY);
      return null;
    }
    if (Date.now() - value.connectedAt > 7 * 24 * 60 * 60 * 1000) {
      getSessionStorage().removeItem(MOBILE_CONNECTION_KEY);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function accountFromConnection(
  connection: MobileConnection
): MobileWalletAccount {
  const publicKey = decodeBase58(connection.walletAddress);
  if (publicKey.length !== 32) {
    throw new Error("Solflare returned an invalid Solana account address.");
  }
  return {
    address: connection.walletAddress,
    publicKey,
    chains: [MOBILE_SESSION_CHAIN],
    features: ["solana:signMessage"]
  };
}

function clearWalletCallbackUrl(): void {
  const url = new URL(window.location.href);
  for (const key of [
    "wallet_provider",
    "wallet_action",
    "wallet_state",
    "solflare_encryption_public_key",
    "wallet_encryption_public_key",
    "nonce",
    "data",
    "errorCode",
    "errorMessage"
  ]) {
    url.searchParams.delete(key);
  }
  window.history.replaceState(
    window.history.state,
    "",
    url.pathname + url.search + url.hash
  );
}

function callbackRedirectLink(
  action: "connect" | "sign_message",
  state: string,
  nextPath: string,
  reason?: string
): string {
  const url = new URL("/auth", window.location.origin);
  url.searchParams.set("wallet_provider", "solflare");
  url.searchParams.set("wallet_action", action);
  url.searchParams.set("wallet_state", state);
  if (nextPath !== "/app") url.searchParams.set("next", nextPath);
  if (reason) url.searchParams.set("reason", reason);
  return url.toString();
}

function readPending<T>(state: string): T | null {
  try {
    const storage = getSessionStorage();
    const key = MOBILE_PENDING_PREFIX + state;
    const raw = storage.getItem(key);
    storage.removeItem(key);
    if (!raw) return null;
    const value = JSON.parse(raw) as T & { createdAt?: number };
    if (
      typeof value.createdAt !== "number" ||
      Date.now() - value.createdAt > MOBILE_PENDING_MAX_AGE_MS
    ) {
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

function setLastUsedWallet(): void {
  try {
    window.localStorage.setItem("paylore-last-wallet", "Solflare");
  } catch {
    // The active connection remains usable for this page even when preferences are unavailable.
  }
}

export function MobileWalletAuthPanel({
  nextPath,
  reason
}: {
  nextPath: string;
  reason?: "inactivity-expired" | "hard-expired" | "logged-out";
}) {
  const router = useRouter();
  const [account, setAccount] = useState<MobileWalletAccount | null>(null);
  const [status, setStatus] = useState<
    "idle" | "connecting" | "signing" | "success"
  >("idle");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function handleWalletCallback(): Promise<void> {
      const params = new URLSearchParams(window.location.search);
      const action = params.get("wallet_action");
      const provider = params.get("wallet_provider");
      const state = params.get("wallet_state");
      if (!action && !provider && !state) {
        const saved = readMobileConnection();
        if (active && saved) {
          try {
            setAccount(accountFromConnection(saved));
          } catch {
            getSessionStorage().removeItem(MOBILE_CONNECTION_KEY);
          }
        }
        return;
      }

      if (
        provider !== "solflare" ||
        (action !== "connect" && action !== "sign_message") ||
        !isValidWalletCallbackState(state)
      ) {
        clearWalletCallbackUrl();
        throw new Error(
          "This wallet response could not be matched to a Paylore request. Reconnect your wallet and try again."
        );
      }

      const pending = readPending<PendingConnect | PendingSignMessage>(state);
      clearWalletCallbackUrl();
      if (!pending || pending.action !== action || pending.state !== state) {
        throw new Error(
          "The wallet response expired or was already used. Start the connection again."
        );
      }

      const walletError = parseWalletError(params);
      if (walletError) {
        throw new Error(walletError);
      }

      const encryptedData = params.get("data");
      const responseNonce = params.get("nonce");
      if (!encryptedData || !responseNonce) {
        throw new Error(
          "Solflare did not return a complete response. Reconnect and try again."
        );
      }

      if (action === "connect") {
        const connectPending = pending as PendingConnect;
        const walletEncryptionPublicKey = params.get(
          "solflare_encryption_public_key"
        );
        if (!walletEncryptionPublicKey) {
          throw new Error(
            "Solflare did not return its connection encryption key."
          );
        }

        const sharedSecret = deriveWalletSharedSecret(
          walletEncryptionPublicKey,
          decodeBase58(connectPending.dappSecretKey)
        );
        const decoded = decryptWalletPayload(
          encryptedData,
          responseNonce,
          sharedSecret
        );
        if (
          !decoded ||
          typeof decoded !== "object" ||
          !("public_key" in decoded) ||
          typeof decoded.public_key !== "string" ||
          !("session" in decoded) ||
          typeof decoded.session !== "string" ||
          !decoded.session
        ) {
          throw new Error(
            "Solflare returned an incomplete connection. Reconnect and try again."
          );
        }

        const connection: MobileConnection = {
          provider: "solflare",
          appUrl: connectPending.appUrl,
          dappPublicKey: connectPending.dappPublicKey,
          dappSecretKey: connectPending.dappSecretKey,
          walletEncryptionPublicKey,
          walletAddress: decoded.public_key,
          session: decoded.session,
          connectedAt: Date.now()
        };
        const nextAccount = accountFromConnection(connection);
        getSessionStorage().setItem(
          MOBILE_CONNECTION_KEY,
          JSON.stringify(connection)
        );
        if (active) {
          setAccount(nextAccount);
          setStatus("idle");
          setError(null);
          setLastUsedWallet();
        }
        return;
      }

      const signPending = pending as PendingSignMessage;
      const connection = readMobileConnection();
      if (
        !connection ||
        connection.walletAddress !== signPending.walletAddress
      ) {
        throw new Error(
          "The Solflare connection changed before sign-in. Reconnect and try again."
        );
      }

      const sharedSecret = deriveWalletSharedSecret(
        connection.walletEncryptionPublicKey,
        decodeBase58(connection.dappSecretKey)
      );
      const decoded = decryptWalletPayload(
        encryptedData,
        responseNonce,
        sharedSecret
      );
      if (
        !decoded ||
        typeof decoded !== "object" ||
        !("signature" in decoded) ||
        typeof decoded.signature !== "string"
      ) {
        throw new Error(
          "Solflare did not return a message signature. Try signing in again."
        );
      }

      const signature = decodeBase58(decoded.signature);
      const signedMessage = new TextEncoder().encode(
        signPending.challengeMessage
      );
      if (signature.length !== 64 || signedMessage.length === 0) {
        throw new Error(
          "Solflare returned an invalid sign-in response. Try again."
        );
      }

      const verifyResponse = await fetch("/api/auth/verify", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          authMethod: "message",
          nonce: signPending.challengeNonce,
          walletAddress: signPending.walletAddress,
          publicKey: toBase64(accountFromConnection(connection).publicKey),
          chains: [MOBILE_SESSION_CHAIN],
          features: ["solana:signMessage"],
          signedMessage: toBase64(signedMessage),
          signature: toBase64(signature)
        })
      });

      if (!verifyResponse.ok) {
        throw new Error(
          verifyResponse.status >= 500
            ? "Sign-in is temporarily unavailable. Please try again."
            : "Authentication failed. Reconnect your wallet and try again."
        );
      }

      getSessionStorage().removeItem(MOBILE_CONNECTION_KEY);
      if (active) {
        setStatus("success");
        router.replace(nextPath);
        router.refresh();
      }
    }

    void handleWalletCallback().catch((cause: unknown) => {
      if (active) {
        setStatus("idle");
        setError(
          cause instanceof Error
            ? cause.message
            : "The wallet request could not be completed. Try again."
        );
      }
    });

    return () => {
      active = false;
    };
  }, [nextPath, router]);

  async function connectSolflare(): Promise<void> {
    setError(null);
    setStatus("connecting");
    try {
      const keyPair = createWalletEncryptionKeyPair();
      const stateBytes = crypto.getRandomValues(new Uint8Array(24));
      const state = [...stateBytes]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const appUrl = new URL("/", window.location.origin).toString();
      const redirectLink = callbackRedirectLink(
        "connect",
        state,
        nextPath,
        reason
      );
      const pending: PendingConnect = {
        action: "connect",
        state,
        provider: "solflare",
        appUrl,
        dappPublicKey: encodeBase58(keyPair.publicKey),
        dappSecretKey: encodeBase58(keyPair.secretKey),
        createdAt: Date.now()
      };
      getSessionStorage().setItem(
        MOBILE_PENDING_PREFIX + state,
        JSON.stringify(pending)
      );

      const deepLink = buildWalletConnectDeepLink({
        provider: "solflare",
        appUrl,
        redirectLink,
        dappEncryptionPublicKey: keyPair.publicKey,
        cluster: "devnet"
      });
      window.location.assign(deepLink);
    } catch (cause) {
      setStatus("idle");
      setError(
        cause instanceof Error
          ? cause.message
          : "Paylore could not open Solflare. Try again."
      );
    }
  }

  async function signInWithSolflare(): Promise<void> {
    const connection = readMobileConnection();
    if (!connection || !account) {
      setAccount(null);
      setError("Reconnect Solflare before signing in.");
      return;
    }

    setError(null);
    setStatus("signing");
    try {
      const challengeResponse = await fetch("/api/auth/challenge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ walletAddress: account.address })
      });
      const challenge = (await challengeResponse.json()) as
        | ChallengeResponse
        | { error: string };
      if (
        !challengeResponse.ok ||
        !("nonce" in challenge) ||
        typeof challenge.message !== "string" ||
        typeof challenge.nonce !== "string"
      ) {
        throw new Error(
          challengeResponse.status >= 500
            ? "Sign-in is temporarily unavailable. Please try again."
            : "Paylore could not prepare the sign-in request. Reconnect and try again."
        );
      }

      const sharedSecret = deriveWalletSharedSecret(
        connection.walletEncryptionPublicKey,
        decodeBase58(connection.dappSecretKey)
      );
      const encrypted = encryptWalletPayload(
        {
          session: connection.session,
          message: encodeBase58(
            new TextEncoder().encode(challenge.message)
          ),
          display: "utf8"
        },
        sharedSecret
      );
      const stateBytes = crypto.getRandomValues(new Uint8Array(24));
      const state = [...stateBytes]
        .map((byte) => byte.toString(16).padStart(2, "0"))
        .join("");
      const redirectLink = callbackRedirectLink(
        "sign_message",
        state,
        nextPath,
        reason
      );
      const pending: PendingSignMessage = {
        action: "sign_message",
        state,
        createdAt: Date.now(),
        challengeNonce: challenge.nonce,
        challengeMessage: challenge.message,
        walletAddress: account.address
      };
      getSessionStorage().setItem(
        MOBILE_PENDING_PREFIX + state,
        JSON.stringify(pending)
      );

      const deepLink = buildWalletSignMessageDeepLink({
        provider: "solflare",
        appUrl: connection.appUrl,
        dappEncryptionPublicKey: decodeBase58(connection.dappPublicKey),
        redirectLink,
        encryptedPayload: encrypted.payload,
        nonce: encrypted.nonce
      });
      window.location.assign(deepLink);
    } catch (cause) {
      setStatus("idle");
      setError(
        cause instanceof Error
          ? cause.message
          : "Paylore could not open the sign-in request. Try again."
      );
    }
  }

  function disconnectSolflare(): void {
    try {
      const storage = getSessionStorage();
      storage.removeItem(MOBILE_CONNECTION_KEY);
      for (let index = storage.length - 1; index >= 0; index -= 1) {
        const key = storage.key(index);
        if (key?.startsWith(MOBILE_PENDING_PREFIX)) {
          storage.removeItem(key);
        }
      }
    } catch {
      // Disconnecting still clears the visible account if browser storage is unavailable.
    }
    setAccount(null);
    setStatus("idle");
    setError(null);
  }

  const expiredNotice =
    reason === "inactivity-expired"
      ? "Your session expired after 12 hours of inactivity. Sign again to continue."
      : reason === "hard-expired"
        ? "Your session reached its 7-day maximum lifetime. Sign in again to continue."
        : reason === "logged-out"
          ? "You have been signed out."
          : null;

  return (
    <div className="auth-card">
      <div className="auth-card__header">
        <h2>Sign in to Paylore</h2>
        <p>
          Connect to a mobile wallet and approve Paylore&apos;s separate sign-in
          message. Signing in proves wallet control; it does not send payroll
          funds or a payroll transaction.
        </p>
      </div>

      {expiredNotice ? (
        <div className="notice" role="status" aria-live="polite">
          {expiredNotice}
        </div>
      ) : null}

      <div className="auth-status">
        <span
          className="status-indicator"
          data-connected={account ? "true" : "false"}
        />
        <div className="auth-status__copy">
          {account ? (
            <>
              <strong>Solflare</strong>
              <span>
                {account.address.slice(0, 5)}…{account.address.slice(-4)}
              </span>
              <small>Connected. Paylore sign-in is still required.</small>
            </>
          ) : (
            <>
              <strong>No wallet is connected</strong>
              <span>
                Open Solflare to approve the connection, then return to Paylore.
              </span>
            </>
          )}
        </div>
      </div>

      <div className="auth-actions">
        {!account ? (
          <button
            className="button"
            type="button"
            onClick={() => void connectSolflare()}
            disabled={status === "connecting" || status === "signing"}
          >
            {status === "connecting" ? (
              <span className="loading-indicator">
                <span className="loading-indicator__icon" aria-hidden="true" />
                Opening Solflare…
              </span>
            ) : (
              "Connect with Solflare"
            )}
          </button>
        ) : (
          <>
            <button
              className="button"
              type="button"
              onClick={() => void signInWithSolflare()}
              disabled={status === "signing" || status === "success"}
            >
              {status === "signing" ? (
                <span className="loading-indicator">
                  <span className="loading-indicator__icon" aria-hidden="true" />
                  Waiting for Solflare…
                </span>
              ) : status === "success" ? (
                "Signed in"
              ) : (
                "Sign in with Solflare"
              )}
            </button>
            <button
              className="button button--secondary"
              type="button"
              onClick={disconnectSolflare}
              disabled={status === "signing"}
            >
              Disconnect wallet
            </button>
          </>
        )}
        <button
          className="button button--secondary"
          type="button"
          disabled
          aria-describedby="backpack-devnet-note"
        >
          Backpack unavailable on Devnet
        </button>
      </div>

      <p className="auth-mobile-note">
        Paylore currently authenticates on Solana Devnet. Solflare&apos;s published
        deep-link connection flow supports Devnet. Backpack&apos;s published
        connection options do not list Devnet, so Paylore will not send a request
        that could default to Mainnet.
      </p>
      <p id="backpack-devnet-note" className="auth-security-note">
        Use a supported desktop Wallet Standard extension with Backpack, or use
        Solflare on mobile for Devnet sign-in.
      </p>

      {error ? (
        <div className="error-box" role="alert" aria-live="assertive">
          {error}
        </div>
      ) : null}
    </div>
  );
}
