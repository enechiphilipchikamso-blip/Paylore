"use client";

import { getWallets } from "@wallet-standard/app";
import {
  SolanaSignAndSendTransaction,
  SolanaSignMessage,
  SolanaSignTransaction,
  type SolanaSignAndSendTransactionInput,
  type SolanaSignAndSendTransactionMethod,
  type SolanaSignMessageMethod,
  type SolanaSignTransactionMethod
} from "@solana/wallet-standard-features";

type WalletAccount = SolanaSignAndSendTransactionInput["account"];

type RegisteredWallet = {
  name: string;
  features: Record<string, unknown>;
  accounts: readonly {
    address: string;
    publicKey: ArrayLike<number>;
    chains: readonly string[];
    features: readonly string[];
  }[];
};

type WalletRegistry = {
  get(): readonly RegisteredWallet[];
};

type SignAndSendFeature = {
  supportedTransactionVersions: readonly (number | "legacy")[];
  signAndSendTransaction: SolanaSignAndSendTransactionMethod;
};

type SignMessageFeature = {
  signMessage: SolanaSignMessageMethod;
};

type SignTransactionFeature = {
  supportedTransactionVersions: readonly (number | "legacy")[];
  signTransaction: SolanaSignTransactionMethod;
};

type DisconnectFeature = {
  disconnect: () => Promise<void>;
};

type ConnectFeature = {
  connect: () => Promise<unknown>;
};

export const WALLET_RECONNECT_REQUIRED =
  "Reconnect the wallet you used to sign in, then try again.";

export function hasAuthenticatedWallet(walletAddress: string): boolean {
  const registry = getWallets() as WalletRegistry;
  return registry.get().some((wallet) =>
    matchesSupportedWallet(wallet.name) &&
    exposesAuthenticatedAccount(wallet, walletAddress)
  );
}

function isSignAndSendFeature(value: unknown): value is SignAndSendFeature {
  return Boolean(
    value &&
      typeof value === "object" &&
      "signAndSendTransaction" in value &&
      typeof value.signAndSendTransaction === "function" &&
      "supportedTransactionVersions" in value &&
      Array.isArray(value.supportedTransactionVersions)
  );
}

function isSignMessageFeature(value: unknown): value is SignMessageFeature {
  return Boolean(
    value &&
      typeof value === "object" &&
      "signMessage" in value &&
      typeof value.signMessage === "function"
  );
}

function isSignTransactionFeature(value: unknown): value is SignTransactionFeature {
  return Boolean(
    value &&
      typeof value === "object" &&
      "signTransaction" in value &&
      typeof value.signTransaction === "function" &&
      "supportedTransactionVersions" in value &&
      Array.isArray(value.supportedTransactionVersions)
  );
}

function isDisconnectFeature(value: unknown): value is DisconnectFeature {
  return Boolean(
    value &&
      typeof value === "object" &&
      "disconnect" in value &&
      typeof value.disconnect === "function"
  );
}

function isConnectFeature(value: unknown): value is ConnectFeature {
  return Boolean(
    value &&
      typeof value === "object" &&
      "connect" in value &&
      typeof value.connect === "function"
  );
}

function normalizeWalletName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function matchesSupportedWallet(name: string): boolean {
  return [
    "phantom",
    "phantomwallet",
    "solflare",
    "solflarewallet",
    "backpack",
    "backpackwallet",
    "jupiter",
    "jupiterwallet",
    "jupiterwalletextension"
  ].includes(normalizeWalletName(name));
}

function exposesAuthenticatedAccount(
  wallet: RegisteredWallet,
  walletAddress: string
): boolean {
  return wallet.accounts.some(
    (account) =>
      account.address === walletAddress &&
      account.chains.includes("solana:devnet")
  );
}

/**
 * A page reload keeps the Paylore session but wallets stop exposing their
 * accounts until the page connects again. Reconnect from a direct click,
 * starting with the wallet last used to sign in, and stop at the first wallet
 * that exposes the authenticated account.
 */
export async function reconnectAuthenticatedWallet(
  walletAddress: string
): Promise<void> {
  const registry = getWallets() as WalletRegistry;
  const wallets = registry.get().filter((registeredWallet) =>
    matchesSupportedWallet(registeredWallet.name) &&
    isConnectFeature(registeredWallet.features["standard:connect"])
  );
  if (wallets.some((wallet) => exposesAuthenticatedAccount(wallet, walletAddress))) {
    return;
  }
  let lastWallet = "";
  try {
    lastWallet = normalizeWalletName(localStorage.getItem("paylore-last-wallet") ?? "");
  } catch {
    lastWallet = "";
  }
  const ordered = lastWallet
    ? [
        ...wallets.filter((wallet) => normalizeWalletName(wallet.name).startsWith(lastWallet)),
        ...wallets.filter((wallet) => !normalizeWalletName(wallet.name).startsWith(lastWallet))
      ]
    : wallets;
  if (ordered.length === 0) {
    throw new Error(
      "No supported wallet was found in this browser. Open Paylore in the browser or wallet app you used to sign in."
    );
  }
  for (const wallet of ordered) {
    const feature = wallet.features["standard:connect"] as ConnectFeature;
    await feature.connect();
    if (exposesAuthenticatedAccount(wallet, walletAddress)) {
      return;
    }
  }
  throw new Error(
    "The connected wallet account is not the one you used to sign in. Switch to that account in your wallet and reconnect, or sign out and sign in again."
  );
}

export function findAuthenticatedWallet(walletAddress: string): {
  account: WalletAccount;
  signAndSendTransaction: SolanaSignAndSendTransactionMethod;
  signMessage: SolanaSignMessageMethod | null;
  signTransaction: SolanaSignTransactionMethod | null;
  disconnect: (() => Promise<void>) | null;
} {
  const registry = getWallets() as WalletRegistry;
  const wallet = registry.get().find((registeredWallet) =>
    matchesSupportedWallet(registeredWallet.name) &&
    exposesAuthenticatedAccount(registeredWallet, walletAddress)
  );
  if (!wallet) {
    throw new Error(WALLET_RECONNECT_REQUIRED);
  }

  const feature = wallet.features[SolanaSignAndSendTransaction];
  const messageFeature = wallet.features[SolanaSignMessage];
  const transactionFeature = wallet.features[SolanaSignTransaction];
  if (
    !isSignAndSendFeature(feature) ||
    !feature.supportedTransactionVersions.includes(0)
  ) {
    throw new Error(
      "This wallet does not support a transaction on the selected Solana network."
    );
  }
  const registeredAccount = wallet.accounts.find(
    (account) =>
      account.address === walletAddress &&
      account.chains.includes("solana:devnet")
  );
  if (!registeredAccount) {
    throw new Error(WALLET_RECONNECT_REQUIRED);
  }
  const disconnectFeature = wallet.features["standard:disconnect"];

  // Wallets expose accounts as class instances whose address and other fields are
  // prototype getters, so copying with spread drops them. Wallets may also require
  // the exact account object they registered, so pass it through unchanged.
  const account = registeredAccount as unknown as WalletAccount;
  return {
    account,
    signAndSendTransaction: feature.signAndSendTransaction,
    signMessage: isSignMessageFeature(messageFeature)
      ? messageFeature.signMessage
      : null,
    signTransaction:
      isSignTransactionFeature(transactionFeature) &&
      transactionFeature.supportedTransactionVersions.includes(0)
        ? transactionFeature.signTransaction
        : null,
    disconnect: isDisconnectFeature(disconnectFeature)
      ? () => disconnectFeature.disconnect()
      : null
  };
}
