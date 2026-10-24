"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  createSubscriptionPaymentTransaction,
  subscriptionPaymentSignature
} from "./subscription-payment-transaction";
import { findAuthenticatedWallet } from "./authenticated-wallet";
import { isWalletCancellation } from "../auth/walletErrors";

type PreparedActivationPayment = {
  attemptId: string;
  payer: string;
  recipient: string;
  mint: string;
  tokenProgram: string;
  blockhash: string;
  lastValidBlockHeight: number;
  memo: string;
  expiresAt: string;
  transaction: Uint8Array;
};

const PREPARATION_FAILURE =
  "The activation transaction could not be prepared. No payment was sent. Please try again.";
const AMBIGUOUS_SUBMISSION =
  "The wallet did not confirm whether it sent the payment. Check your wallet activity before trying again to avoid a duplicate payment. Paylore will reconcile this attempt before allowing a retry.";

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
  const [preparedPayment, setPreparedPayment] = useState<PreparedActivationPayment | null>(null);
  const [progress, setProgress] = useState<string | null>(null);

  async function verifyPayment(signature: string, paymentAttemptId = attemptId): Promise<boolean> {
    const endpoint = paymentAttemptId
      ? `/api/workspaces/${workspaceId}/billing/attempt`
      : `/api/workspaces/${workspaceId}/billing`;
    const body = paymentAttemptId ? { attemptId: paymentAttemptId, signature } : { signature };
    const response = await fetch(endpoint, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    const result = await response.json().catch(() => null) as { status?: string } | null;
    if (!response.ok || (paymentAttemptId && result?.status !== "active")) return false;
    setPendingSignature(null);
    setSubmissionUncertain(false);
    setPreparedPayment(null);
    setProgress(null);
    onSuccess?.();
    if (refreshOnSuccess) router.refresh();
    return true;
  }

  async function retryVerification() {
    if (!pendingSignature) return;
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

  async function reconcileAttempt() {
    if (!attemptId) {
      setPartial("This payment attempt has no saved reference. Check wallet activity before starting another payment.");
      return;
    }
    setBusy(true);
    setError(null);
    setPartial(null);
    setProgress("Checking finalized wallet history for the original payment. Do not submit a duplicate.");
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/billing/attempt`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ attemptId })
      });
      const result = await response.json().catch(() => null) as { status?: string; error?: string } | null;
      if (response.ok && result?.status === "active") {
        setSubmissionUncertain(false);
        setPendingSignature(null);
        setPreparedPayment(null);
        setPartial(null);
        onSuccess?.();
        if (refreshOnSuccess) router.refresh();
      } else if (response.ok && result?.status === "safe_to_retry") {
        setSubmissionUncertain(false);
        setPendingSignature(null);
        setPreparedPayment(null);
        setPartial("The original blockhash expired, and finalized wallet history contains no matching payment. You can safely start a new activation attempt.");
      } else {
        setPartial("The original payment is not yet resolved. Do not submit another payment; check status again shortly.");
      }
    } catch {
      setPartial("Paylore could not reconcile the original payment. Do not submit another payment until its status is resolved.");
    } finally {
      setProgress(null);
      setBusy(false);
    }
  }

  async function prepareActivation() {
    setBusy(true);
    setError(null);
    setPartial(null);
    setSubmissionUncertain(false);
    setPreparedPayment(null);
    setProgress("Preparing your $49 USDC payment…");
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
            : PREPARATION_FAILURE
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

      if (
        prepared.payer !== walletAddress ||
        !prepared.attemptId ||
        !prepared.recipient ||
        !prepared.mint ||
        !prepared.tokenProgram ||
        !prepared.blockhash ||
        !Number.isSafeInteger(prepared.lastValidBlockHeight) ||
        !Number.isFinite(Date.parse(prepared.expiresAt))
      ) {
        throw new Error("The prepared payment details do not match your authenticated wallet.");
      }

      const transaction = await createSubscriptionPaymentTransaction({
        ...prepared,
        workspaceId,
        memo: prepared.memo
      });
      const payment: PreparedActivationPayment = { ...prepared, transaction };
      setAttemptId(prepared.attemptId);
      setPreparedPayment(payment);
      setPartial("Payment details are ready. Review the amount, network, wallet and recipient below, then open your wallet to approve this payment.");
      setProgress(null);
    } catch (cause) {
      setPreparedPayment(null);
      setProgress(null);
      const reason = cause instanceof Error ? cause.message : PREPARATION_FAILURE;
      setError(
        reason === "The prepared payment details do not match your authenticated wallet."
          ? reason
          : reason === PREPARATION_FAILURE || reason.startsWith("Payment setup is incomplete.")
            ? reason
            : PREPARATION_FAILURE
      );
    } finally {
      setBusy(false);
    }
  }

  async function submitPreparedPayment() {
    const prepared = preparedPayment;
    if (!prepared || busy || pendingSignature || submissionUncertain) return;

    if (Date.now() >= Date.parse(prepared.expiresAt)) {
      setPreparedPayment(null);
      setError("The prepared payment expired. No payment was sent. Prepare a new activation payment before continuing.");
      setPartial(null);
      return;
    }

    let wallet: ReturnType<typeof findAuthenticatedWallet>;
    try {
      wallet = findAuthenticatedWallet(walletAddress);
    } catch {
      setError("Reconnect the wallet you used to sign in, then try again.");
      return;
    }

    if (wallet.account.address !== prepared.payer || wallet.account.address !== walletAddress) {
      setPreparedPayment(null);
      setError("Your authenticated wallet changed. Sign in again before paying.");
      return;
    }

    setBusy(true);
    setError(null);
    setPartial(null);
    setProgress("Waiting for wallet approval…");
    let walletSubmissionStarted = false;
    try {
      walletSubmissionStarted = true;
      // The wallet request starts synchronously from this approval click; no asynchronous preparation remains between the click and wallet invocation.
      const submission = wallet.signAndSendTransaction({
        account: wallet.account,
        transaction: prepared.transaction,
        chain: "solana:devnet",
        options: { commitment: "confirmed" }
      });
      setPreparedPayment(null);
      const [sent] = await submission;
      if (!sent) {
        throw new Error("The wallet did not return a transaction signature.");
      }

      const signature = subscriptionPaymentSignature(sent.signature);
      walletSubmissionStarted = false;
      setPendingSignature(signature);
      setSubmissionUncertain(false);
      setProgress("Payment submitted. Waiting for network confirmation…");
      let verified = false;
      try {
        verified = await verifyPayment(signature, prepared.attemptId);
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
      }
    } catch (cause) {
      if (isWalletCancellation(cause)) {
        setProgress(null);
        setPreparedPayment(null);
        setPartial("Payment was canceled. No payment was sent.");
      } else if (walletSubmissionStarted) {
        setSubmissionUncertain(true);
        setPartial(AMBIGUOUS_SUBMISSION);
      } else {
        setProgress(null);
        setError(PREPARATION_FAILURE);
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
      {preparedPayment && !busy && !pendingSignature && !submissionUncertain ? (
        <section className="surface-card subscription-payment-review" aria-labelledby="subscription-payment-review-heading">
          <h2 id="subscription-payment-review-heading">Review activation payment</h2>
          <dl>
            <div><dt>Amount</dt><dd>$49.00 USDC</dd></div>
            <div><dt>Network</dt><dd>Solana Devnet</dd></div>
            <div><dt>From</dt><dd><code>{preparedPayment.payer}</code></dd></div>
            <div><dt>Recipient</dt><dd><code>{preparedPayment.recipient}</code></dd></div>
            <div><dt>USDC mint</dt><dd><code>{preparedPayment.mint}</code></dd></div>
          </dl>
        </section>
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
          onClick={() => void reconcileAttempt()}
          type="button"
        >
          Check payment status
        </button>
      ) : preparedPayment ? (
        <button
          className="button"
          onClick={() => void submitPreparedPayment()}
          type="button"
        >
          Open wallet to approve $49 USDC
        </button>
      ) : (
        <button
          className="button"
          disabled={!configured}
          onClick={() => void prepareActivation()}
          type="button"
        >
          {error ? "Please try again" : actionLabel}
        </button>
      )}
    </div>
  );
}
