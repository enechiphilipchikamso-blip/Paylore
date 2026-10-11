"use client";

import { useState } from "react";
import {
  SolanaSignAndSendTransaction,
  type SolanaSignAndSendTransactionInput,
  type SolanaSignAndSendTransactionMethod
} from "@solana/wallet-standard-features";
import { useRouter } from "next/navigation";
import {
  createSubscriptionPaymentTransaction,
  subscriptionPaymentSignature
} from "./subscription-payment-transaction";
import { isWalletCancellation } from "../auth/walletErrors";

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

function isSignAndSendFeature(
  value: unknown
): value is SignAndSendFeature {
  return Boolean(
    value &&
      typeof value === "object" &&
      "signAndSendTransaction" in value &&
      typeof value.signAndSendTransaction === "function" &&
      "supportedTransactionVersions" in value &&
      Array.isArray(value.supportedTransactionVersions)
  );
}

function normalizedName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
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
  ].includes(normalizedName(name));
}

async function findAuthenticatedWallet(
  walletAddress: string
): Promise<{
  account: WalletAccount;
  signAndSendTransaction: SolanaSignAndSendTransactionMethod;
}> {
  const { getWallets } = await import("@wallet-standard/app");
  const registry = getWallets() as WalletRegistry;
  const wallet = registry.get().find((registeredWallet) => {
    if (!matchesSupportedWallet(registeredWallet.name)) {
      return false;
    }
    return registeredWallet.accounts.some(
      (account) =>
        account.address === walletAddress &&
        account.chains.includes("solana:devnet")
    );
  });

  if (!wallet) {
    throw new Error(
      "Reconnect the wallet you used to sign in, then try again."
    );
  }

  const feature = wallet.features[SolanaSignAndSendTransaction];
  if (
    !isSignAndSendFeature(feature) ||
    !feature.supportedTransactionVersions.includes(0)
  ) {
    throw new Error(
      "This wallet does not support a Devnet transaction for workspace activation."
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

  const account: WalletAccount = {
    ...registeredAccount,
    publicKey: Uint8Array.from(registeredAccount.publicKey),
    chains: registeredAccount.chains.filter(
      (chain): chain is WalletAccount["chains"][number] =>
        chain === "solana:devnet"
    ),
    features: registeredAccount.features.filter(
      (feature): feature is WalletAccount["features"][number] =>
        feature.includes(":")
    )
  };

  return {
    account,
    signAndSendTransaction: feature.signAndSendTransaction
  };
}

export function SubscriptionPaymentAction({
  workspaceId,
  walletAddress,
  configured,
  actionLabel,
  refreshOnSuccess = true,
  onSuccess
}: {
  workspaceId: string;
  walletAddress: string;
  configured: boolean;
  actionLabel: string;
  refreshOnSuccess?: boolean;
  onSuccess?: () => void;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [partial, setPartial] = useState<string | null>(null);
  const [pendingSignature, setPendingSignature] = useState<string | null>(null);
  const [submissionUncertain, setSubmissionUncertain] = useState(false);

  async function verifyPayment(signature: string): Promise<boolean> {
    const response = await fetch(
      `/api/workspaces/${workspaceId}/billing`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signature })
      }
    );
    if (!response.ok) {
      return false;
    }
    setPendingSignature(null);
    onSuccess?.();
    if (refreshOnSuccess) {
      router.refresh();
    }
    return true;
  }

  async function retryVerification() {
    if (!pendingSignature) {
      return;
    }
    setBusy(true);
    setPartial(null);
    try {
      if (!(await verifyPayment(pendingSignature))) {
        setPartial(
          "Paylore has not confirmed activation yet. You can retry verification without sending another payment."
        );
      }
    } catch {
      setPartial(
        "Paylore could not check the transaction yet. Retry verification; do not send another payment."
      );
    } finally {
      setBusy(false);
    }
  }

  async function activate() {
    setBusy(true);
    setError(null);
    setPartial(null);
    setSubmissionUncertain(false);
    let walletSubmissionStarted = false;
    try {
      const prepareResponse = await fetch(
        `/api/workspaces/${workspaceId}/billing/prepare`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: "{}"
        }
      );
      if (!prepareResponse.ok) {
        throw new Error(
          prepareResponse.status === 503
            ? "Devnet payment setup is incomplete. Check the approved subscription recipient and USDC mint configuration."
            : "Workspace activation could not be prepared. Please try again."
        );
      }

      const prepared: {
        payer: string;
        recipient: string;
        mint: string;
        blockhash: string;
        lastValidBlockHeight: number;
      } = await prepareResponse.json();
      if (prepared.payer !== walletAddress) {
        throw new Error(
          "Your authenticated wallet changed. Sign in again before paying."
        );
      }

      const transaction = await createSubscriptionPaymentTransaction(prepared);
      const wallet = await findAuthenticatedWallet(walletAddress);
      walletSubmissionStarted = true;
      const [sent] = await wallet.signAndSendTransaction({
        account: wallet.account,
        transaction,
        chain: "solana:devnet",
        options: { commitment: "confirmed" }
      });
      if (!sent) {
        throw new Error("The wallet did not return a transaction signature.");
      }

      const signature = subscriptionPaymentSignature(sent.signature);
      walletSubmissionStarted = false;
      setPendingSignature(signature);
      let verified = false;
      try {
        verified = await verifyPayment(signature);
      } catch {
        setPartial(
          "The wallet sent the transaction, but Paylore could not check it yet. Retry verification here; do not send another payment."
        );
        return;
      }
      if (!verified) {
        setPartial(
          "The wallet sent the transaction, but Paylore has not confirmed activation yet. Retry verification here; do not send another payment."
        );
        return;
      }
    } catch (cause) {
      const message =
        cause instanceof Error
          ? cause.message
          : "Workspace activation could not be completed.";
      if (isWalletCancellation(cause)) {
        setPartial("The wallet request was cancelled. No activation payment was sent.");
      } else if (walletSubmissionStarted) {
        setSubmissionUncertain(true);
        setPartial(
          "The wallet did not confirm whether it sent the payment. Check your wallet activity before trying again to avoid a duplicate payment."
        );
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="subscription-payment-action">
      {error ? (
        <div className="state-callout" data-state="error" role="alert">
          <span className="state-callout__signal" aria-hidden="true" />
          <p>{error}</p>
        </div>
      ) : null}
      {partial ? (
        <div className="state-callout" data-state="partial" role="status">
          <span className="state-callout__signal" aria-hidden="true" />
          <p>{partial}</p>
        </div>
      ) : null}
      {busy ? (
        <p className="loading-indicator" role="status" aria-live="polite">
          <span className="loading-indicator__icon" aria-hidden="true" />
          Activating your workspace…
        </p>
      ) : pendingSignature ? (
        <button
          className="button button--secondary"
          onClick={() => void retryVerification()}
          type="button"
        >
          Retry payment verification
        </button>
      ) : submissionUncertain ? (
        <button
          className="button button--secondary"
          onClick={() => void activate()}
          type="button"
        >
          I checked my wallet activity — please try again
        </button>
      ) : (
        <button
          className="button"
          disabled={!configured}
          onClick={() => void activate()}
          type="button"
        >
          {error ? "Please try again" : actionLabel}
        </button>
      )}
    </div>
  );
}
