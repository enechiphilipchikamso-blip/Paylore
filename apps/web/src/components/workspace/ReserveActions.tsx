"use client";

import { useRouter } from "next/navigation";
import { useCallback, useState } from "react";

type OnChainAccountState = {
  status:
    | "not_checked"
    | "no_reserve"
    | "not_configured"
    | "account_missing"
    | "account_verified";
  tokenAccount: string | null;
};

export function ReserveActions({
  workspaceId,
  reserve,
  canInitialize
}: {
  workspaceId: string;
  reserve: {
    address: string;
    createdAt: string;
    updatedAt: string;
  } | null;
  canInitialize: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [activeAction, setActiveAction] = useState<
    "initialize" | "restore" | null
  >(null);
  const [notice, setNotice] = useState<{
    state: "success" | "error" | "partial";
    text: string;
  } | null>(null);
  const [onChainAccount, setOnChainAccount] =
    useState<OnChainAccountState>({ status: "not_checked", tokenAccount: null });
  const [checkingOnChain, setCheckingOnChain] = useState(false);

  const refreshOnChainState = useCallback(async () => {
    setCheckingOnChain(true);
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/settings/reserve`,
        { cache: "no-store", credentials: "same-origin" }
      );
      const result = await response.json();
      if (!response.ok || !result?.onChainAccount) {
        throw new Error("Reserve on-chain state could not be reconciled.");
      }
      setOnChainAccount(result.onChainAccount as OnChainAccountState);
    } catch (error) {
      setOnChainAccount({ status: "not_checked", tokenAccount: null });
      setNotice({
        state: "error",
        text: error instanceof Error
          ? error.message
          : "Reserve on-chain state could not be reconciled."
      });
    } finally {
      setCheckingOnChain(false);
    }
  }, [workspaceId]);

  async function run(action: "initialize" | "restore") {
    setBusy(true);
    setActiveAction(action);
    setNotice(null);
    try {
      const response = await fetch(
        `/api/workspaces/${workspaceId}/settings/reserve`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({ action })
        }
      );
      if (!response.ok) {
        setNotice({
          state: "error",
          text: action === "initialize"
            ? "Reserve signing-key custody could not be configured. Please try again."
            : "The encrypted reserve signing-key backup could not be verified. Please try again."
        });
        return;
      }
      setNotice({
        state: "success",
        text: action === "initialize"
          ? "Reserve signing-key custody configured. This does not create or fund an on-chain confidential reserve."
          : "The encrypted reserve signing-key backup was verified and restored. The on-chain confidential reserve is still not initialized or funded."
      });
      router.refresh();
    } catch {
      setNotice({
        state: "error",
        text: "Reserve unavailable — try again. No private-key material is shown here."
      });
    } finally {
      setBusy(false);
      setActiveAction(null);
    }
  }

  return (
    <div className="reserve-actions">
      {notice ? (
        <div className="state-callout" data-state={notice.state} role={notice.state === "error" ? "alert" : "status"}>
          <span className="state-callout__signal" aria-hidden="true" />
          <p>{notice.text}</p>
        </div>
      ) : null}
      {busy ? (
        <p className="loading-indicator" role="status">
          <span className="loading-indicator__icon" aria-hidden="true" />
          {activeAction === "restore"
            ? "Verifying reserve signing-key backup…"
            : "Configuring reserve signing-key custody…"}
        </p>
      ) : null}
      {reserve ? (
        <section className="reserve-summary">
          <h2>Reserve key custody configured</h2>
          <dl className="billing-period">
            <div><dt>Signing-key custody</dt><dd>Configured</dd></div>
            <div><dt>Reserve signing address</dt><dd><code>{reserve.address}</code></dd></div>
            <div><dt>Key custody configured</dt><dd>{new Date(reserve.createdAt).toLocaleString()}</dd></div>
            <div><dt>Key custody last updated</dt><dd>{new Date(reserve.updatedAt).toLocaleString()}</dd></div>
          </dl>
          <p className="notice">
            This address is not yet an initialized or funded Token-2022
            confidential reserve. Payroll settlement is unavailable until the
            on-chain reserve flow is implemented and verified.
          </p>
          <h3>On-chain Token-2022 account check</h3>
          {checkingOnChain ? (
            <p role="status">Checking finalized Devnet account state…</p>
          ) : onChainAccount?.status === "account_missing" ? (
            <p role="status">
              The expected wrapped-USDC Token-2022 associated account is not
              initialized. No reserve funding or confidential settlement is
              available.
            </p>
          ) : onChainAccount?.status === "account_verified" ? (
            <>
              <p role="status">
                The finalized account owner and mint match the configured
                reserve. This identity check does not verify confidential
                transfer initialization, confidential balance, or funding.
              </p>
              <p>Associated token account: <code>{onChainAccount.tokenAccount}</code></p>
            </>
          ) : onChainAccount?.status === "not_configured" ? (
            <p role="status">
              The wrapped-USDC mint is not configured; on-chain Reserve
              reconciliation is unavailable.
            </p>
          ) : onChainAccount?.status === "no_reserve" ? (
            <p role="status">No reserve signing address exists to reconcile.</p>
          ) : onChainAccount?.status === "not_checked" ? (
            <p role="status">
              On-chain Reserve state has not been checked in this session.
            </p>
          ) : (
            <p role="alert">
              On-chain Reserve state could not be verified. Do not fund or use
              this address for payroll.
            </p>
          )}
          <button
            className="button button--secondary"
            disabled={checkingOnChain}
            onClick={() => void refreshOnChainState()}
            type="button"
          >
            Refresh on-chain check
          </button>
          {canInitialize ? (
            <button
              className="button button--secondary"
              disabled={busy}
              onClick={() => void run("restore")}
              type="button"
            >
              Verify encrypted backup
            </button>
          ) : null}
        </section>
      ) : (
        <section className="reserve-summary">
          <h2>Reserve key custody not configured</h2>
          <p>
            Configure encrypted custody for the reserve signing key. This
            action does not create or fund an on-chain confidential reserve.
          </p>
          {canInitialize ? (
            <button
              className="button"
              disabled={busy}
              onClick={() => void run("initialize")}
              type="button"
            >
              Configure reserve key custody
            </button>
          ) : null}
        </section>
      )}
      <p className="notice">
        Paylore does not display reserve private keys, envelope secrets,
        provider API keys, database credentials, or session tokens.
      </p>
    </div>
  );
}
