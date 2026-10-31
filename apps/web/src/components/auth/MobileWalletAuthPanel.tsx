"use client";

import Image from "next/image";
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
  parseWalletError,
  type MobileDeepLinkWallet,
  type MobileDeepLinkCluster
} from "./mobile-wallet-deeplink";

const MOBILE_CONNECTION_KEY = "paylore:mobile-wallet:connection:v1";
const MOBILE_PENDING_PREFIX = "paylore:mobile-wallet:pending:v1:";
const MOBILE_PENDING_MAX_AGE_MS = 10 * 60 * 1000;

type MobileWalletAccount = {
  address: string;
  publicKey: Uint8Array;
  provider: MobileDeepLinkWallet;
};

type MobileConnection = {
  provider: MobileDeepLinkWallet;
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
  provider: MobileDeepLinkWallet;
  appUrl: string;
  dappPublicKey: string;
  dappSecretKey: string;
  createdAt: number;
};

type PendingSignMessage = {
  action: "sign_message";
  provider: MobileDeepLinkWallet;
  state: string;
  createdAt: number;
  challengeNonce: string;
  challengeMessage: string;
  chainId: string;
  walletAddress: string;
};

type ChallengeResponse = {
  nonce: string;
  input: { chainId: string };
  message: string;
};

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
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
      (value.provider !== "solflare" && value.provider !== "backpack") ||
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
    throw new Error("The wallet returned an invalid Solana account address.");
  }
  return {
    address: connection.walletAddress,
    publicKey,
    provider: connection.provider
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
  provider: MobileDeepLinkWallet,
  action: "connect" | "sign_message",
  state: string,
  nextPath: string,
  reason?: string
): string {
  const url = new URL("/auth", window.location.origin);
  url.searchParams.set("wallet_provider", provider);
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

function setLastUsedWallet(provider: MobileDeepLinkWallet): void {
  try {
    window.localStorage.setItem(
      "paylore-last-wallet",
      provider === "solflare" ? "Solflare" : "Backpack"
    );
  } catch {
    // The active connection remains usable for this page even when preferences are unavailable.
  }
}

export function MobileWalletAuthPanel({
  nextPath,
  reason,
  walletCluster,
  backpackDeepLinkEnabled
}: {
  nextPath: string;
  reason?: "inactivity-expired" | "hard-expired" | "logged-out";
  walletCluster: MobileDeepLinkCluster;
  backpackDeepLinkEnabled: boolean;
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
        (provider !== "solflare" && provider !== "backpack") ||
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
      if (
        !pending ||
        pending.action !== action ||
        pending.state !== state ||
        pending.provider !== provider
      ) {
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
          "The wallet did not return a complete response. Reconnect and try again."
        );
      }

      if (action === "connect") {
        const connectPending = pending as PendingConnect;
        const encryptionKeyParameter =
          provider === "solflare"
            ? "solflare_encryption_public_key"
            : "wallet_encryption_public_key";
        const walletEncryptionPublicKey = params.get(
          encryptionKeyParameter
        );
        if (!walletEncryptionPublicKey) {
          throw new Error(
            "The wallet did not return its connection encryption key."
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
            "The wallet returned an incomplete connection. Reconnect and try again."
          );
        }

        const connection: MobileConnection = {
          provider,
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
          setLastUsedWallet(provider);
        }
        return;
      }

      const signPending = pending as PendingSignMessage;
      const connection = readMobileConnection();
      if (
        !connection ||
        connection.provider !== provider ||
        signPending.provider !== provider ||
        connection.walletAddress !== signPending.walletAddress
      ) {
        throw new Error(
          "The wallet connection changed before sign-in. Reconnect and try again."
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
          "The wallet did not return a message signature. Try signing in again."
        );
      }

      const signature = decodeBase58(decoded.signature);
      const signedMessage = new TextEncoder().encode(
        signPending.challengeMessage
      );
      if (signature.length !== 64 || signedMessage.length === 0) {
        throw new Error(
          "The wallet returned an invalid sign-in response. Try again."
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
          chains: [signPending.chainId],
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

  async function connectMobileWallet(provider: MobileDeepLinkWallet): Promise<void> {
    if (provider === "backpack" && !backpackDeepLinkEnabled) {
      setError("The Backpack app link is turned off for this deployment. Open Paylore inside Backpack to connect through its browser.");
      return;
    }
    setError(null);
    setStatus("connecting");
    try {
      const keyPair = createWalletEncryptionKeyPair();
      const state = createState();
      const appUrl = new URL("/", window.location.origin).toString();
      const redirectLink = callbackRedirectLink(
        provider,
        "connect",
        state,
        nextPath,
        reason
      );
      const pending: PendingConnect = {
        action: "connect",
        state,
        provider,
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
        provider,
        appUrl,
        redirectLink,
        dappEncryptionPublicKey: keyPair.publicKey,
        cluster: walletCluster
      });
      window.location.assign(deepLink);
    } catch (cause) {
      setStatus("idle");
      setError(
        cause instanceof Error
          ? cause.message
          : "Paylore could not open the wallet app. Try again."
      );
    }
  }

  async function signInWithMobileWallet(provider: MobileDeepLinkWallet): Promise<void> {
    const connection = readMobileConnection();
    if (!connection || connection.provider !== provider || !account || account.provider !== provider) {
      setAccount(null);
      setError("Reconnect your wallet before signing in.");
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
        typeof challenge.nonce !== "string" ||
        !challenge.input ||
        typeof challenge.input.chainId !== "string"
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
      const state = createState();
      const redirectLink = callbackRedirectLink(
        provider,
        "sign_message",
        state,
        nextPath,
        reason
      );
      const pending: PendingSignMessage = {
        action: "sign_message",
        provider,
        state,
        createdAt: Date.now(),
        challengeNonce: challenge.nonce,
        challengeMessage: challenge.message,
        chainId: challenge.input.chainId,
        walletAddress: account.address
      };
      getSessionStorage().setItem(
        MOBILE_PENDING_PREFIX + state,
        JSON.stringify(pending)
      );

      const deepLink = buildWalletSignMessageDeepLink({
        provider,
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
          : "Paylore could not open the wallet sign-in request. Try again."
      );
    }
  }

  function disconnectMobileWallet(): void {
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

  const mobileWalletOptions = [
    { label: "Solflare", iconSrc: "/brand/wallets/solflare.svg", provider: "solflare" as const },
    { label: "Backpack", iconSrc: "/brand/wallets/backpack.png", provider: "backpack" as const }
  ];

  return (
    <>
      {expiredNotice ? (
        <div className="notice" role="status" aria-live="polite">
          {expiredNotice}
        </div>
      ) : null}

      {account ? (
        <div className="auth-status auth-status--mobile-wallet" role="status">
          <span className="status-indicator" data-connected="true" />
          <div className="auth-status__copy">
            <strong>Connected with {account.provider === "solflare" ? "Solflare" : "Backpack"}</strong>
            <span>{account.address.slice(0, 5)}…{account.address.slice(-4)}</span>
            <small>Paylore sign-in is still required.</small>
          </div>
        </div>
      ) : null}

      <section className="wallet-chooser wallet-app-links" aria-label="Connect with a wallet app">
        <div className="wallet-chooser__header">
          <div>
            <h3>Connect with a wallet app</h3>
            <p>Open Solflare or Backpack when you want to connect through its app.</p>
          </div>
        </div>
        <div className="wallet-choices">
          {mobileWalletOptions.map((option) => {
            const selected = account?.provider === option.provider;
            const disabledBySetting =
              option.provider === "backpack" && !backpackDeepLinkEnabled;
            return (
              <button
                className="wallet-choice"
                key={option.label}
                type="button"
                disabled={
                  status === "connecting" ||
                  status === "signing" ||
                  disabledBySetting ||
                  Boolean(account && !selected)
                }
                onClick={() => {
                  if (!account && !disabledBySetting) {
                    void connectMobileWallet(option.provider);
                  }
                }}
                aria-label={
                  disabledBySetting
                    ? "Backpack app link unavailable"
                    : selected
                      ? "Connected to " + option.label
                      : "Connect with " + option.label
                }
                aria-pressed={selected}
                aria-describedby={
                  disabledBySetting ? "backpack-app-link-note" : undefined
                }
              >
                <span
                  className={
                    disabledBySetting
                      ? "wallet-choice__icon wallet-choice__icon--muted"
                      : "wallet-choice__icon"
                  }
                  aria-hidden="true"
                >
                  <Image
                    src={option.iconSrc}
                    alt=""
                    width={44}
                    height={44}
                    unoptimized
                  />
                </span>
                <span className="wallet-choice__copy">
                  <span className="wallet-choice__name">{option.label}</span>
                  {selected && account ? (
                    <small>Connected · {account.address.slice(0, 5)}…{account.address.slice(-4)}</small>
                  ) : disabledBySetting ? (
                    <small id="backpack-app-link-note">
                      The app link is turned off for this deployment. Connect through Backpack&apos;s browser instead.
                    </small>
                  ) : null}
                </span>
              </button>
            );
          })}
        </div>
      </section>

      {account ? (
        <div className="auth-actions">
          <button
            className="button"
            type="button"
            onClick={() => void signInWithMobileWallet(account.provider)}
            disabled={status === "signing" || status === "success"}
          >
            {status === "signing" ? (
              <span className="loading-indicator">
                <span className="loading-indicator__icon" aria-hidden="true" />
                Waiting for wallet…
              </span>
            ) : status === "success" ? (
              "Signed in"
            ) : (
              "Sign in with wallet"
            )}
          </button>
          <button
            className="button button--secondary"
            type="button"
            onClick={disconnectMobileWallet}
            disabled={status === "signing"}
          >
            Disconnect wallet
          </button>
        </div>
      ) : null}

      <p className="auth-security-note">
        Signing in is an authentication action. It does not send payroll funds.
      </p>

      {error ? (
        <div className="error-box" role="alert" aria-live="assertive">
          {error}
        </div>
      ) : null}
    </>
  );
}
