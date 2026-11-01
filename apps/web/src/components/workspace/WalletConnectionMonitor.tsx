"use client";

import { getWallets } from "@wallet-standard/app";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import {
  hasAuthenticatedWallet,
  reconnectAuthenticatedWallet
} from "./authenticated-wallet";
import { isWalletCancellation } from "../auth/walletErrors";

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

export function WalletConnectionMonitor() {
  const pathname = usePathname();
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [disconnected, setDisconnected] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [toastVisible, setToastVisible] = useState(false);
  const previousConnection = useRef<boolean | null>(null);
  const isDashboardPage = /^\/workspace\/[^/]+(?:\/|$)/.test(pathname);
  const isDashboardHome = /^\/workspace\/[^/]+$/.test(pathname);

  useEffect(() => {
    let active = true;
    let disconnectTimer: number | undefined;
    let interval: number | undefined;
    let unsubscribeRegister = () => {};
    let unsubscribeUnregister = () => {};
    let toastTimer: number | undefined;

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
          setMessage(null);
          setToastVisible(false);
        } else {
          if (previousConnection.current !== false) {
            setMessage(
              "Your wallet connection is unavailable. Go to your administrator workspace home, contributor dashboard home, or auditor dashboard home and reconnect your wallet to continue."
            );
            setToastVisible(true);
            window.clearTimeout(toastTimer);
            toastTimer = window.setTimeout(() => setToastVisible(false), 5_000);
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
      window.clearTimeout(toastTimer);
      window.clearInterval(interval);
      unsubscribeRegister();
      unsubscribeUnregister();
    };
  }, []);

  async function reconnect() {
    if (!walletAddress || reconnecting) return;
    setReconnecting(true);
    setMessage(null);
    setToastVisible(false);
    try {
      await reconnectAuthenticatedWallet(walletAddress);
      setDisconnected(false);
      previousConnection.current = true;
      setMessage("Wallet reconnected. You can return to your dashboard.");
      setToastVisible(true);
      window.setTimeout(() => setToastVisible(false), 5_000);
    } catch (error) {
      setDisconnected(true);
      setMessage(isWalletCancellation(error)
        ? "Wallet reconnection was cancelled."
        : error instanceof Error
          ? error.message
          : "The wallet could not be reconnected. Try again from your wallet home page.");
    } finally {
      setReconnecting(false);
    }
  }

  if (!isDashboardPage) return null;
  if (!toastVisible && (!disconnected || !isDashboardHome)) return null;

  return (
    <aside
      className={`wallet-connection-notice${toastVisible ? " wallet-connection-notice--toast" : ""}`}
      role={toastVisible ? "alert" : "status"}
      aria-live="polite"
    >
      <strong>{disconnected ? "Wallet connection needed" : "Wallet reconnected"}</strong>
      {toastVisible && message ? <p>{message}</p> : null}
      {disconnected && isDashboardHome ? (
        <button
          className="button"
          type="button"
          disabled={reconnecting}
          aria-busy={reconnecting}
          onClick={() => void reconnect()}
        >
          {reconnecting ? "Reconnecting…" : "Reconnect wallet"}
        </button>
      ) : null}
      {toastVisible ? (
        <button
          className="wallet-connection-notice__close"
          type="button"
          aria-label="Dismiss wallet connection notification"
          onClick={() => setToastVisible(false)}
        >
          ×
        </button>
      ) : null}
    </aside>
  );
}
