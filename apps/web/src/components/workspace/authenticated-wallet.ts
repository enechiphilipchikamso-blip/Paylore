"use client";

import {
  SolanaSignAndSendTransaction,
  SolanaSignMessage,
  type SolanaSignAndSendTransactionInput,
  type SolanaSignAndSendTransactionMethod,
  type SolanaSignMessageMethod
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

type DisconnectFeature = {
  disconnect: () => Promise<void>;
};

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

function isDisconnectFeature(value: unknown): value is DisconnectFeature {
  return Boolean(
    value &&
      typeof value === "object" &&
      "disconnect" in value &&
      typeof value.disconnect === "function"
  );
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
  ].includes(name.toLowerCase().replace(/[^a-z0-9]/g, ""));
}

export async function findAuthenticatedWallet(walletAddress: string): Promise<{
  account: WalletAccount;
  signAndSendTransaction: SolanaSignAndSendTransactionMethod;
  signMessage: SolanaSignMessageMethod | null;
  disconnect: (() => Promise<void>) | null;
}> {
  const { getWallets } = await import("@wallet-standard/app");
  const registry = getWallets() as WalletRegistry;
  const wallet = registry.get().find((registeredWallet) =>
    matchesSupportedWallet(registeredWallet.name) &&
    registeredWallet.accounts.some(
      (account) =>
        account.address === walletAddress &&
        account.chains.includes("solana:devnet")
    )
  );
  if (!wallet) {
    throw new Error(
      "Reconnect the wallet you used to sign in, then try again."
    );
  }

  const feature = wallet.features[SolanaSignAndSendTransaction];
  const messageFeature = wallet.features[SolanaSignMessage];
  if (
    !isSignAndSendFeature(feature) ||
    !feature.supportedTransactionVersions.includes(0)
  ) {
    throw new Error(
      "This wallet does not support a Devnet transaction for this operation."
    );
  }
  const registeredAccount = wallet.accounts.find(
    (account) =>
      account.address === walletAddress &&
      account.chains.includes("solana:devnet")
  );
  if (!registeredAccount) {
    throw new Error(
      "Reconnect the wallet you used to sign in, then try again."
    );
  }
  const disconnectFeature = wallet.features["standard:disconnect"];

  const account: WalletAccount = {
    ...registeredAccount,
    publicKey: Uint8Array.from(registeredAccount.publicKey),
    chains: registeredAccount.chains.filter(
      (chain): chain is WalletAccount["chains"][number] =>
        chain === "solana:devnet"
    ),
    features: registeredAccount.features.filter(
      (entry): entry is WalletAccount["features"][number] =>
        entry.includes(":")
    )
  };
  return {
    account,
    signAndSendTransaction: feature.signAndSendTransaction,
    signMessage: isSignMessageFeature(messageFeature)
      ? messageFeature.signMessage
      : null,
    disconnect: isDisconnectFeature(disconnectFeature)
      ? () => disconnectFeature.disconnect()
      : null
  };
}
