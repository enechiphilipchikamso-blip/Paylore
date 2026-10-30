"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { SubscriptionPaymentAction } from "./SubscriptionPaymentAction";

type SubscriptionStatus =
  | "inactive"
  | "active"
  | "cancel_scheduled"
  | "archived";

export type SubscriptionPaymentView = {
  signature: string;
  amountBaseUnits: string;
  periodStart: string;
  periodEnd: string;
  verifiedAt: string;
};

export function BillingActions({
  workspaceId,
  walletAddress,
  paymentRecipient,
  paymentMint,
  status,
  periodStart,
  periodEnd,
  cancelAtPeriodEnd,
  payments,
  canManage
}: {
  workspaceId: string;
  walletAddress: string;
  paymentRecipient: string | null;
  paymentMint: string | null;
  status: SubscriptionStatus;
  periodStart: string | null;
  periodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  payments: SubscriptionPaymentView[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [confirmCancellation, setConfirmCancellation] = useState(false);
  const [message, setMessage] = useState<{
    state: "success" | "error" | "partial";
    text: string;
  } | null>(null);

  const active = status === "active" || status === "cancel_scheduled";
  const endpoint = `/api/workspaces/${workspaceId}/billing`;

  async function updateCancellation(action: "cancel" | "keep-active") {
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(endpoint, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ action })
      });
      if (!response.ok) {
        setMessage({
          state: "error",
          text: "Subscription settings could not be updated. Please try again."
        });
        return;
      }
      setConfirmCancellation(false);
      setMessage({
        state: "success",
        text: action === "cancel"
          ? "Cancellation scheduled for the end of the paid period."
          : "Workspace renewal remains active."
      });
      router.refresh();
    } catch {
      setMessage({
        state: "error",
        text: "Something went wrong. Please try again."
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="billing-actions">
      {message ? (
        <div className="state-callout" data-state={message.state} role={message.state === "error" ? "alert" : "status"}>
          <span className="state-callout__signal" aria-hidden="true" />
          <p>{message.text}</p>
        </div>
      ) : null}

      {busy ? (
        <p className="loading-indicator" role="status">
          <span className="loading-indicator__icon" aria-hidden="true" />
          Verifying…
        </p>
      ) : null}

      {canManage && !active ? (
        <div className="billing-payment-form">
          <h2>{status === "archived" ? "Renew workspace" : "Activate workspace"}</h2>
          <p>
            Review a one-time payment of exactly 49 USDC to the Paylore
            recipient address using the wallet you authenticated with. Future
            renewals require a separate payment; Paylore does not pull funds
            automatically.
          </p>
          {paymentRecipient && paymentMint ? (
            <dl className="billing-payment-target">
              <div><dt>Network</dt><dd>Solana</dd></div>
              <div><dt>Amount</dt><dd>49 USDC</dd></div>
              <div><dt>Recipient</dt><dd><code>{paymentRecipient}</code></dd></div>
              <div><dt>USDC mint</dt><dd><code>{paymentMint}</code></dd></div>
            </dl>
          ) : (
            <div className="state-callout" data-state="partial" role="status">
              <span className="state-callout__signal" aria-hidden="true" />
              <p>Payment setup is incomplete. The subscription recipient and approved USDC mint must be configured before payment can be submitted.</p>
            </div>
          )}
          <SubscriptionPaymentAction
            actionLabel={status === "archived" ? "Renew now" : "Activate workspace"}
            configured={Boolean(paymentRecipient && paymentMint)}
            onSuccess={() => {
              setMessage({
                state: "success",
                text: "Payment verified. Workspace activated."
              });
              router.refresh();
            }}
            walletAddress={walletAddress}
            workspaceId={workspaceId}
          />
        </div>
      ) : null}

      {canManage && active ? (
        <div className="billing-management">
          {confirmCancellation ? (
            <div className="state-callout" data-state="partial">
              <span className="state-callout__signal" aria-hidden="true" />
              <div>
                <p>Cancellation takes effect at the end of the paid period.</p>
                <div className="hero__actions">
                  <button
                    className="button button--secondary"
                    disabled={busy}
                    aria-busy={busy}
                    onClick={() => void updateCancellation("cancel")}
                    type="button"
                  >
                    Confirm cancellation
                  </button>
                  <button
                    className="button button--secondary"
                    onClick={() => setConfirmCancellation(false)}
                    type="button"
                  >
                    Keep active
                  </button>
                </div>
              </div>
            </div>
          ) : cancelAtPeriodEnd ? (
            <button
              className="button button--secondary"
              disabled={busy}
              aria-busy={busy}
              onClick={() => void updateCancellation("keep-active")}
              type="button"
            >
              Keep active
            </button>
          ) : (
            <button
              className="button button--secondary"
              disabled={busy}
              onClick={() => setConfirmCancellation(true)}
              type="button"
            >
              Cancel at period end
            </button>
          )}
        </div>
      ) : null}

      {!canManage ? (
        <p className="notice">
          Only an Organization Administrator can change workspace billing.
        </p>
      ) : null}

      <section aria-labelledby="subscription-history-heading" className="subscription-history">
        <h2 id="subscription-history-heading">Subscription history</h2>
        {payments.length === 0 ? (
          <div className="workspace-empty-state">
            <h3>No subscription payments recorded</h3>
            <p>Verified workspace payments will appear here with their billing period and transaction reference.</p>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Period</th>
                  <th scope="col">State</th>
                  <th scope="col">Payment</th>
                  <th scope="col">Transaction</th>
                </tr>
              </thead>
              <tbody>
                {payments.map((payment) => (
                  <tr key={payment.signature}>
                    <td>
                      {new Date(payment.periodStart).toLocaleDateString()} –{" "}
                      {new Date(payment.periodEnd).toLocaleDateString()}
                    </td>
                    <td>Paid</td>
                    <td className="financial-value">49 USDC</td>
                    <td>
                      <code>{payment.signature.slice(0, 8)}…{payment.signature.slice(-8)}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <dl className="billing-period">
        {periodStart ? <div><dt>Period started</dt><dd>{new Date(periodStart).toLocaleDateString()}</dd></div> : null}
        {periodEnd ? <div><dt>Paid through</dt><dd>{new Date(periodEnd).toLocaleDateString()}</dd></div> : null}
      </dl>
    </div>
  );
}
