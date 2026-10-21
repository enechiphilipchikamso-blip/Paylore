"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  createSubscriptionPaymentTransaction,
  subscriptionPaymentSignature
} from "./subscription-payment-transaction";
import { findAuthenticatedWallet } from "./authenticated-wallet";
import { isWalletCancellation } from "../auth/walletErrors";

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
  const [attemptId, setAttemptId] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

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
    setProgress("Preparing your $49 USDC payment…");
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
            ? "Payment setup is incomplete. Check the approved subscription recipient and USDC mint configuration."
            : "Workspace activation could not be prepared. Please try again."
        );
      }

      const prepared: {
        payer: string;
        recipient: string;
        mint: string;
        tokenProgram: string;
        blockhash: string;
        lastValidBlockHeight: number;
        attemptId: string;
        memo: string;
        expiresAt: string;
      } = await prepareResponse.json();
      setAttemptId(prepared.attemptId);
      if (prepared.payer !== walletAddress) {
        throw new Error(
          "Your authenticated wallet changed. Sign in again before paying."
        );
      }

      const transaction = await createSubscriptionPaymentTransaction({
        ...prepared,
        workspaceId,
        memo: prepared.memo
      });
      const wallet = await findAuthenticatedWallet(walletAddress);
      setProgress("Waiting for wallet approval…");
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
        setProgress(null);
        setPartial("The wallet request was cancelled. No activation payment was sent.");
      } else if (walletSubmissionStarted) {
        setSubmissionUncertain(true);
        setPartial(
          "The wallet did not return a transaction confirmation. Check your wallet activity before trying again to avoid a duplicate payment."
        );
      } else {
        setProgress(null);
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
          {progress || "Activating your workspace…"}
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
