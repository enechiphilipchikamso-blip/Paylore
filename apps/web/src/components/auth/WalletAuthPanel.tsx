"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { UnifiedWalletButton } from "@jup-ag/wallet-adapter";
import { useWallet } from "@solana/wallet-adapter-react";
import type {
  SolanaSignInInput,
  SolanaSignInOutput
} from "@solana/wallet-standard-features";

type ChallengeResponse = {
  nonce: string;
  input: SolanaSignInInput;
  message: string;
};

type AuthPanelProps = {
  nextPath: string;
  reason?:
    | "inactivity-expired"
    | "hard-expired"
    | "logged-out";
};

type SignInAdapter = {
  signIn?: (
    input: SolanaSignInInput
  ) => Promise<SolanaSignInOutput>;
};

function bytesToBase64(
  bytes: Uint8Array
): string {
  let binary = "";

  const chunkSize = 0x8000;

  for (
    let offset = 0;
    offset < bytes.length;
    offset += chunkSize
  ) {
    binary += String.fromCharCode(
      ...bytes.slice(
        offset,
        offset + chunkSize
      )
    );
  }

  return btoa(binary);
}

function reasonCopy(
  reason:
    | "inactivity-expired"
    | "hard-expired"
    | "logged-out"
    | undefined
) {
  switch (reason) {
    case "inactivity-expired":
      return "Your 12-hour inactivity window expired. Sign with your wallet to re-authenticate.";
    case "hard-expired":
      return "Your 7-day session lifetime ended. A fresh normal login is required.";
    case "logged-out":
      return "You have been signed out.";
    default:
      return null;
  }
}

export function WalletAuthPanel({
  nextPath,
  reason
}: AuthPanelProps) {
  const router = useRouter();

  const {
    connected,
    publicKey,
    signMessage,
    disconnect,
    wallet
  } = useWallet();

  const [status, setStatus] = useState<
    "idle" | "signing" | "success"
  >("idle");

  const [error, setError] = useState<
    string | null
  >(null);

  const notice = reasonCopy(reason);

  async function authenticate() {
    if (!publicKey || !connected) {
      setError(
        "Connect a supported wallet before signing in."
      );
      return;
    }

    setError(null);
    setStatus("signing");

    try {
      const walletAddress =
        publicKey.toBase58();

      const challengeResponse =
        await fetch(
          "/api/auth/challenge",
          {
            method: "POST",
            headers: {
              "content-type":
                "application/json"
            },
            credentials: "same-origin",
            body: JSON.stringify({
              walletAddress
            })
          }
        );

      const challengeBody =
        (await challengeResponse.json()) as
          | ChallengeResponse
          | { error: string };

      if (
        !challengeResponse.ok ||
        !("nonce" in challengeBody)
      ) {
        throw new Error(
          "Authentication challenge could not be created."
        );
      }

      const adapter =
        wallet?.adapter as
          | SignInAdapter
          | undefined;

      let verifyPayload:
        | {
            nonce: string;
            method: "siws";
            walletAddress: string;
            signedMessage: string;
            signature: string;
          }
        | {
            nonce: string;
            method: "raw";
            walletAddress: string;
            signature: string;
          };

      if (
        adapter &&
        typeof adapter.signIn ===
          "function"
      ) {
        const output =
          await adapter.signIn(
            challengeBody.input
          );

        verifyPayload = {
          nonce: challengeBody.nonce,
          method: "siws",
          walletAddress,
          signedMessage:
            bytesToBase64(
              output.signedMessage
            ),
          signature: bytesToBase64(
            output.signature
          )
        };
      } else if (signMessage) {
        const signature =
          await signMessage(
            new TextEncoder().encode(
              challengeBody.message
            )
          );

        verifyPayload = {
          nonce: challengeBody.nonce,
          method: "raw",
          walletAddress,
          signature:
            bytesToBase64(signature)
        };
      } else {
        throw new Error(
          "This wallet does not expose a supported signing capability."
        );
      }

      const verifyResponse =
        await fetch(
          "/api/auth/verify",
          {
            method: "POST",
            headers: {
              "content-type":
                "application/json"
            },
            credentials: "same-origin",
            body: JSON.stringify(
              verifyPayload
            )
          }
        );

      const verifyBody =
        (await verifyResponse.json()) as
          | {
              authenticated: true;
            }
          | { error: string };

      if (
        !verifyResponse.ok ||
        !("authenticated" in verifyBody)
      ) {
        throw new Error(
          "Wallet authentication failed."
        );
      }

      setStatus("success");

      router.replace(nextPath);
      router.refresh();
    } catch (cause) {
      setStatus("idle");

      if (
        cause instanceof Error
      ) {
        setError(cause.message);
      } else {
        setError(
          "Wallet authentication failed."
        );
      }
    }
  }

  return (
    <div className="auth-card">
      <div className="auth-card__header">
        <p className="eyebrow">
          Wallet identity
        </p>

        <h2>Sign in to Paylore</h2>

        <p>
          Connect your Solana wallet, then
          explicitly sign the Paylore authentication
          challenge. Connecting a wallet alone never
          creates an authenticated session.
        </p>
      </div>

      {notice ? (
        <div
          className="notice"
          role="status"
          aria-live="polite"
        >
          {notice}
        </div>
      ) : null}

      <div className="auth-status">
        <span
          className="status-indicator"
          data-connected={
            connected ? "true" : "false"
          }
        />

        <span>
          {connected && publicKey
            ? `Connected: ${publicKey.toBase58()}`
            : "No wallet is connected"}
        </span>
      </div>

      <div className="auth-actions">
        <div className="wallet-button-wrap">
          <UnifiedWalletButton />
        </div>

        <button
          className="button"
          type="button"
          disabled={
            !connected ||
            !publicKey ||
            status === "signing" ||
            status === "success"
          }
          onClick={authenticate}
        >
          {status === "signing"
            ? "Waiting for signature…"
            : status === "success"
              ? "Signed in"
              : "Sign in with wallet"}
        </button>

        {connected ? (
          <button
            className="button button--secondary"
            type="button"
            onClick={() =>
              void disconnect()
            }
            disabled={status === "signing"}
          >
            Disconnect wallet
          </button>
        ) : null}
      </div>

      <p className="auth-help">
        Signing is an authentication action; it
        does not send a payroll transaction.
      </p>

      {error ? (
        <div
          className="error-box"
          role="alert"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}