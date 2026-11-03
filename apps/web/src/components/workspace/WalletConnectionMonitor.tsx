"use client";

import { getWallets } from "@wallet-standard/app";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { WorkspaceRole } from "../../server/authorization-policy";
import {
  hasAuthenticatedWallet,
  reconnectAuthenticatedWallet
} from "./authenticated-wallet";
import { isWalletCancellation } from "../auth/walletErrors";
import {
  walletConnectionHomeLabel,
  walletDisconnectedCardMessage,
  walletDisconnectedToastMessage
} from "./wallet-connection-copy";

type SessionState = {
  authenticated?: boolean;
  walletAddress?: string;
};

type RegisteredWallet = {
  name: string;
  accounts: readonly unknown[];
};

type WalletRegistry = {
  get(): readonly RegisteredWallet[];
  on(event: "register" | "unregister", listener: () => void): () => void;
};

const SUPPORTED_WALLETS = new Set([
  "phantom",
  "phantomwallet",
  "solflare",
  "solflarewallet",
  "backpack",
  "backpackwallet",
  "jupiter",
  "jupiterwallet",
  "jupiterwalletextension"
]);

function normalizedWalletName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function hasRegisteredSupportedWallet(registry: WalletRegistry): boolean {
  return registry.get().some((wallet) =>
    SUPPORTED_WALLETS.has(normalizedWalletName(wallet.name))
  );
}

type ToastState = { kind: "disconnected" | "reconnected" } | null;

const DISCONNECTED_TOAST_MS = 9_000;
const RECONNECTED_TOAST_MS = 5_000;

// Remembers that the current disconnect was already announced, so moving
// between workspace pages does not replay the same toast on every navigation.
let disconnectAnnounced = false;

export function WalletConnectionMonitor({
  workspaceId,
  role
}: {
  workspaceId: string;
  role: WorkspaceRole;
}) {
  const pathname = usePathname();
  const homeHref = `/workspace/${workspaceId}`;
  const isDashboardHome = pathname === homeHref;
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<ToastState>(null);
  const previousConnection = useRef<boolean | null>(null);
  const toastTimer = useRef<number | undefined>(undefined);

  function showToast(kind: "disconnected" | "reconnected") {
    window.clearTimeout(toastTimer.current);
    setToast({ kind });
    toastTimer.current = window.setTimeout(
      () => setToast(null),
      kind === "disconnected" ? DISCONNECTED_TOAST_MS : RECONNECTED_TOAST_MS
    );
  }

  function dismissToast() {
    window.clearTimeout(toastTimer.current);
    setToast(null);
  }

  useEffect(() => {
    let active = true;
    let disconnectTimer: number | undefined;
    let interval: number | undefined;
    let unsubscribeRegister = () => {};
    let unsubscribeUnregister = () => {};

    void fetch("/api/auth/session", {
      credentials: "same-origin",
      cache: "no-store"
    }).then(async (response) => {
      const session = await response.json() as SessionState;
      if (!active || !response.ok || session.authenticated !== true ||
          typeof session.walletAddress !== "string") return;
      setWalletAddress(session.walletAddress);

      const registry = getWallets() as WalletRegistry;
      const check = () => {
        if (!active || !hasRegisteredSupportedWallet(registry)) return;
        const connected = hasAuthenticatedWallet(session.walletAddress!);
        setDisconnected(!connected);
        if (connected) {
          previousConnection.current = true;
          disconnectAnnounced = false;
          setError(null);
          setToast((current) =>
            current?.kind === "disconnected" ? null : current
          );
        } else {
          if (previousConnection.current !== false && !disconnectAnnounced) {
            disconnectAnnounced = true;
            showToast("disconnected");
          }
          previousConnection.current = false;
        }
      };
      unsubscribeRegister = registry.on("register", check);
      unsubscribeUnregister = registry.on("unregister", check);
      disconnectTimer = window.setTimeout(check, 1_500);
      interval = window.setInterval(check, 1_000);
      check();
    }).catch(() => {
      // Session and wallet availability are rechecked by the next navigation.
    });

    return () => {
      active = false;
      window.clearTimeout(disconnectTimer);
      window.clearTimeout(toastTimer.current);
      window.clearInterval(interval);
      unsubscribeRegister();
      unsubscribeUnregister();
    };
  }, []);

  async function reconnect() {
    if (!walletAddress || reconnecting) return;
    setReconnecting(true);
    setError(null);
    dismissToast();
    try {
      await reconnectAuthenticatedWallet(walletAddress);
      setDisconnected(false);
      previousConnection.current = true;
      disconnectAnnounced = false;
      showToast("reconnected");
    } catch (reconnectError) {
      setDisconnected(true);
      setError(isWalletCancellation(reconnectError)
        ? "Wallet reconnection was cancelled. Approve the request in your wallet to continue."
        : reconnectError instanceof Error
          ? reconnectError.message
          : "The wallet could not be reconnected. Try again.");
    } finally {
      setReconnecting(false);
    }
  }

  // The home page shows the inline reconnect card instead of the warning toast.
  const visibleToast =
    toast?.kind === "disconnected" && isDashboardHome ? null : toast;
  const shortWallet = walletAddress
    ? `${walletAddress.slice(0, 4)}…${walletAddress.slice(-4)}`
    : null;

  return (
    <>
      {disconnected && isDashboardHome ? (
        <section
          className="wallet-reconnect-card"
          aria-labelledby="wallet-reconnect-heading"
          role="region"
        >
          <span className="wallet-reconnect-card__icon" aria-hidden="true">
            <WalletIcon />
          </span>
          <div className="wallet-reconnect-card__body">
            <h2 id="wallet-reconnect-heading">Wallet connection needed</h2>
            <p>{walletDisconnectedCardMessage(role)}</p>
            {shortWallet ? (
              <p className="wallet-reconnect-card__wallet">
                Signed-in wallet <code title={walletAddress ?? undefined}>{shortWallet}</code>
              </p>
            ) : null}
            {error ? (
              <p className="wallet-reconnect-card__error" role="alert">{error}</p>
            ) : null}
          </div>
          <button
            className="button wallet-reconnect-card__action"
            type="button"
            disabled={reconnecting}
            aria-busy={reconnecting}
            onClick={() => void reconnect()}
          >
            {reconnecting ? "Reconnecting…" : "Reconnect wallet"}
          </button>
        </section>
      ) : null}
      {visibleToast && typeof document !== "undefined"
        ? createPortal(
            <div className="wallet-toast-region">
              <div
                className="wallet-toast"
                data-kind={visibleToast.kind}
                role={visibleToast.kind === "disconnected" ? "alert" : "status"}
                aria-live={visibleToast.kind === "disconnected" ? "assertive" : "polite"}
              >
                <span className="wallet-toast__icon" aria-hidden="true">
                  {visibleToast.kind === "disconnected" ? <WalletIcon /> : <CheckIcon />}
                </span>
                <div className="wallet-toast__body">
                  <strong>
                    {visibleToast.kind === "disconnected"
                      ? "Wallet connection needed"
                      : "Wallet reconnected"}
                  </strong>
                  <p>
                    {visibleToast.kind === "disconnected"
                      ? walletDisconnectedToastMessage(role)
                      : "Your wallet is connected again. You can continue where you left off."}
                  </p>
                  {visibleToast.kind === "disconnected" && !isDashboardHome ? (
                    <Link
                      className="wallet-toast__action"
                      href={homeHref}
                      onClick={dismissToast}
                    >
                      Go to {walletConnectionHomeLabel(role)}
                    </Link>
                  ) : null}
                </div>
                <button
                  className="wallet-toast__close"
                  type="button"
                  aria-label="Dismiss wallet connection notification"
                  onClick={dismissToast}
                >
                  <span aria-hidden="true">×</span>
                </button>
              </div>
            </div>,
            document.body
          )
        : null}
    </>
  );
}

function WalletIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
      strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M19 7V5.5A1.5 1.5 0 0 0 17.5 4h-12A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20h12a1.5 1.5 0 0 0 1.5-1.5V17" />
      <path d="M21 8h-5a3 3 0 0 0 0 6h5a1 1 0 0 0 1-1V9a1 1 0 0 0-1-1Z" />
      <circle cx="16" cy="11" r="0.6" fill="currentColor" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor"
      strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="m5 12.5 4.5 4.5L19 7.5" />
    </svg>
  );
}
