"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";

type ReservePhase = "account_setup" | "program_configure";
type ReserveAction = "initialize" | "restore" | "initialize_confidential";
type OnChainAccountState = {
  status:
    | "not_checked"
    | "no_reserve"
    | "not_configured"
    | "account_missing"
    | "confidential_account_ready"
    | "workspace_program_not_initialized"
    | "program_configured";
  reserveAddress?: string;
  tokenAccount?: string | null;
  confidentialTransferReady?: boolean;
  publicBalanceBaseUnits?: string;
  availableBalanceBaseUnits?: string;
  pendingBalanceBaseUnits?: string;
  fundingState?: "unfunded" | "public_funds_available" | "pending_confidential_balance" | "confidential_funds_available";
  programReserveConfigured?: boolean;
  signature?: string;
  phase?: ReservePhase;
};

function fundingStateLabel(state: OnChainAccountState["fundingState"]): string {
  switch (state) {
    case "confidential_funds_available": return "Confidential funds available";
    case "pending_confidential_balance": return "Confidential funds pending";
    case "public_funds_available": return "Public wrapped-USDC available";
    case "unfunded": return "No funds detected";
    default: return "Unavailable";
  }
}

function fundingStateDescription(state: OnChainAccountState["fundingState"]): string {
  switch (state) {
    case "confidential_funds_available":
      return "A finalized confidential available balance is present. Each payroll claim still checks the exact amount required before transfer.";
    case "pending_confidential_balance":
      return "Funds are in the confidential pending balance and cannot be transferred until applied. Paylore applies pending reserve funds during settlement.";
    case "public_funds_available":
      return "Public wrapped-USDC is present. Settlement deposits the required amount into the confidential balance before transferring, after checking the exact allocation.";
    case "unfunded":
      return "No public, pending, or available wrapped-USDC funds were found in finalized state. Fund this reserve before expecting a payroll claim to settle.";
    default:
      return "Funding state is unavailable. Refresh the finalized on-chain check before relying on reserve readiness.";
  }
}

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
  const [activeAction, setActiveAction] = useState<ReserveAction | null>(null);
  const [notice, setNotice] = useState<{
    state: "success" | "error" | "partial";
    text: string;
  } | null>(null);
  const [onChainAccount, setOnChainAccount] = useState<OnChainAccountState>({
    status: "not_checked",
    tokenAccount: null
  });
  const [checkingOnChain, setCheckingOnChain] = useState(true);
  const [setupSignature, setSetupSignature] = useState<string | null>(null);
  const [setupPhase, setSetupPhase] = useState<ReservePhase | null>(null);

  const loadOnChainState = useCallback(async () => {
    const response = await fetch(
      `/api/workspaces/${workspaceId}/settings/reserve`,
      { cache: "no-store", credentials: "same-origin" }
    );
    const result = await response.json() as { onChainAccount?: OnChainAccountState; error?: string };
    if (!response.ok || !result?.onChainAccount) {
      throw new Error(result?.error ?? "Reserve on-chain state could not be reconciled.");
    }
    return result.onChainAccount;
  }, [workspaceId]);

  const refreshOnChainState = useCallback(async () => {
    setCheckingOnChain(true);
    try {
      const state = await loadOnChainState();
      setOnChainAccount(state);
      if (state.status === "program_configured") {
        setSetupSignature(null);
        setSetupPhase(null);
      }
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
  }, [loadOnChainState]);

  useEffect(() => {
    let active = true;
    loadOnChainState().then((state) => {
      if (!active) return;
      setOnChainAccount(state);
      if (state.status === "program_configured") {
        setSetupSignature(null);
        setSetupPhase(null);
      }
    }).catch((error: unknown) => {
      if (!active) return;
      setOnChainAccount({ status: "not_checked", tokenAccount: null });
      setNotice({
        state: "error",
        text: error instanceof Error
          ? error.message
          : "Reserve on-chain state could not be reconciled."
      });
    }).finally(() => {
      if (active) setCheckingOnChain(false);
    });
    return () => {
      active = false;
    };
  }, [loadOnChainState]);

  async function run(action: ReserveAction) {
    if (busy) return;
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
          body: JSON.stringify({
            action,
            ...(action === "initialize_confidential"
              ? { signature: setupSignature, phase: setupPhase }
              : {})
          })
        }
      );
      const result = await response.json().catch(() => null) as {
        status?: string;
        error?: string;
        signature?: string | null;
        phase?: ReservePhase | null;
        tokenAccount?: string | null;
        confidentialTransferReady?: boolean;
        publicBalanceBaseUnits?: string;
        availableBalanceBaseUnits?: string;
        pendingBalanceBaseUnits?: string;
        fundingState?: "unfunded" | "public_funds_available" | "pending_confidential_balance" | "confidential_funds_available";
        programReserveConfigured?: boolean;
        created?: boolean;
        restoredAt?: string | null;
      } | null;

      if (!response.ok) {
        const messageByError: Record<string, string> = {
          reserve_mint_authority_approval_required:
            "The wrapped-USDC mint has not approved the reserve for confidential transfers. The reserve account was not marked ready.",
          workspace_program_not_initialized:
            "The Paylore Program workspace state is not initialized. Reserve setup stopped before submitting transactions.",
          reserve_devnet_rpc_required:
            "Reserve operations are restricted to the configured Devnet RPC. No transaction was submitted.",
          reserve_confidential_account_not_ready:
            "The reserve token account does not yet have verified confidential-transfer readiness. No reserve readiness is claimed.",
          reserve_gas_tank_not_initialized:
            "Set up the workspace Gas Tank before initializing the confidential reserve.",
          reserve_gas_tank_insufficient_funds:
            "The workspace Gas Tank does not have enough SOL to cover reserve setup fees and account rent. Fund the Gas Tank, then retry.",
          reserve_gas_tank_balance_unavailable:
            "Paylore could not verify the Gas Tank's current SOL balance. No reserve setup transaction was submitted. Refresh the Gas Tank page and retry.",
          reserve_gas_tank_key_mismatch:
            "The stored Gas Tank signing identity did not match its recorded address. Reserve setup was stopped for safety; contact support before retrying.",
          reserve_gas_tank_custody_unavailable:
            "Paylore could not access the encrypted Gas Tank signing key. Reserve setup was not confirmed. Retry after checking Gas Tank status.",
          reserve_token_account_identity_mismatch:
            "The expected reserve token account exists with a different owner or mint. No reserve setup transaction was submitted."
        };
        setNotice({
          state: "error",
          text: messageByError[result?.error ?? ""] ??
            (action === "initialize"
              ? "Reserve signing-key custody could not be configured. Please try again."
              : action === "restore"
                ? "The encrypted reserve signing-key backup could not be verified. Please try again."
                : "Paylore could not complete confidential reserve setup. Refresh the Reserve page and check any submitted transaction before trying again.")
        });
        return;
      }

      if (action === "initialize_confidential") {
        if (result?.status === "pending") {
          setSetupSignature(result.signature ?? setupSignature);
          setSetupPhase(result.phase ?? setupPhase);
          setNotice({
            state: "partial",
            text: result.phase === "account_setup"
              ? "The reserve confidential-account setup transaction is awaiting finality. Check this same attempt before starting another."
              : "The Payroll Program reserve configuration is awaiting finality. Check this same attempt before starting another."
          });
          await refreshOnChainState();
          return;
        }
        if (result?.status === "retry_ready") {
          setSetupSignature(null);
          setSetupPhase(null);
          setNotice({
            state: "partial",
            text: "The previous reserve setup transaction finalized unsuccessfully. Recheck the account state before starting a new attempt."
          });
          await refreshOnChainState();
          return;
        }
        if (result?.status === "workspace_program_not_initialized") {
          setSetupSignature(null);
          setSetupPhase(null);
          setNotice({
            state: "partial",
            text: result.confidentialTransferReady
              ? "The reserve-owned confidential account is ready, but the Paylore Program workspace state has not been initialized. The program reserve remains unconfigured."
              : "The Paylore Program workspace state is not initialized. Paylore stopped before submitting reserve setup transactions; complete workspace setup first."
          });
          setOnChainAccount(result as OnChainAccountState);
          return;
        }
        if (result?.status === "program_configured" && result.programReserveConfigured === true &&
            result.confidentialTransferReady === true && typeof result.tokenAccount === "string") {
          setSetupSignature(null);
          setSetupPhase(null);
          setOnChainAccount(result as OnChainAccountState);
          setNotice({
            state: "success",
            text: "The reserve confidential account and Paylore Program reserve state were verified. This does not mean the reserve has been funded."
          });
          router.refresh();
          return;
        }
        setSetupSignature(null);
        setSetupPhase(null);
        await refreshOnChainState();
        setNotice({
          state: "partial",
          text: "The reserve setup did not establish a verified configured reserve. Review the on-chain state before retrying."
        });
        return;
      }

      setNotice({
        state: "success",
        text: action === "initialize"
          ? "Reserve signing-key custody configured. This does not create or fund an on-chain confidential reserve."
          : "The encrypted reserve signing-key backup was verified and restored. On-chain reserve readiness is checked separately."
      });
      router.refresh();
      await refreshOnChainState();
    } catch {
      setNotice({
        state: "partial",
        text: action === "initialize_confidential"
          ? "The reserve response was interrupted. Check the existing on-chain setup state before starting another attempt."
          : "Reserve unavailable — try again. No private-key material is shown here."
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
            : activeAction === "initialize_confidential"
              ? setupPhase === "program_configure"
                ? "Verifying the Paylore Program reserve…"
                : "Configuring the reserve confidential account…"
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
          <h3>Confidential reserve readiness</h3>
          {checkingOnChain ? (
            <p role="status">Checking finalized Devnet account and program state…</p>
          ) : onChainAccount.status === "account_missing" ? (
            <p role="status">The expected reserve-owned wrapped-USDC Token-2022 account does not exist. Confidential settlement is unavailable.</p>
          ) : onChainAccount.status === "workspace_program_not_initialized" ? (
            <p role="status">The reserve confidential token account is ready, but the Paylore Program workspace account has not been initialized. The reserve program state is not configured.</p>
          ) : onChainAccount.status === "confidential_account_ready" ? (
            <p role="status">The reserve confidential token account is configured, but the Paylore Program reserve state is not yet verified.</p>
          ) : onChainAccount.status === "program_configured" ? (
            <>
              <p role="status">The finalized reserve token account and Paylore Program reserve state match. The state check does not by itself mean the reserve is funded.</p>

              <dl className="billing-period">
                <div><dt>Confidential transfers ready</dt><dd>{onChainAccount.confidentialTransferReady ? "Yes" : "No"}</dd></div>
                <div><dt>Funding readiness</dt><dd>{fundingStateLabel(onChainAccount.fundingState)}</dd></div>
                <div><dt>Public wrapped-USDC balance</dt><dd>{onChainAccount.publicBalanceBaseUnits ?? "Unavailable"} base units</dd></div>
                <div><dt>Available confidential balance</dt><dd>{onChainAccount.availableBalanceBaseUnits ?? "Unavailable"} base units</dd></div>
                <div><dt>Pending confidential balance</dt><dd>{onChainAccount.pendingBalanceBaseUnits ?? "Unavailable"} base units</dd></div>
              </dl>
              <p role="status">{fundingStateDescription(onChainAccount.fundingState)}</p>
            </>
          ) : onChainAccount.status === "not_configured" ? (
            <p role="status">The wrapped-USDC mint or Payroll Program is not configured. On-chain reserve setup is unavailable.</p>
          ) : onChainAccount.status === "no_reserve" ? (
            <p role="status">No reserve signing address exists to reconcile.</p>
          ) : onChainAccount.status === "not_checked" ? (
            <p role="status">The on-chain reserve state could not be checked in this session.</p>
          ) : (
            <p role="alert">On-chain reserve state is not verified. Do not report the confidential reserve as ready or funded.</p>
          )}
          {onChainAccount.tokenAccount && onChainAccount.confidentialTransferReady ? (
            <section className="reserve-summary" aria-label="Manual reserve funding">
              <h3>Manual reserve funding</h3>
              <p>Reserve Token-2022 account: <code>{onChainAccount.tokenAccount}</code></p>
              <p>Public wrapped-USDC balance: {onChainAccount.publicBalanceBaseUnits ?? "Unavailable"} base units.</p>
              <p>To fund the reserve, send only the configured wrapped-USDC mint on Devnet to this token account. Plain USDC or another mint is not interchangeable. Paylore does not sweep or automatically refill the reserve.</p>
              <button
                className="button button--secondary"
                onClick={() => {
                  const tokenAccount = onChainAccount.tokenAccount;
                  if (!tokenAccount) return;
                  void navigator.clipboard.writeText(tokenAccount).then(() => {
                    setNotice({ state: "success", text: "Reserve token-account address copied." });
                  }).catch(() => {
                    setNotice({ state: "error", text: "Could not copy the reserve token-account address. Select and copy the address shown above." });
                  });
                }}
                type="button"
              >
                Copy reserve token-account address
              </button>
            </section>
          ) : null}
          <button className="button button--secondary" disabled={checkingOnChain} onClick={() => {
            setCheckingOnChain(true);
            void refreshOnChainState();
          }} type="button">
            Refresh on-chain check
          </button>
          {canInitialize ? (
            <>
              <button className="button button--secondary" disabled={busy} onClick={() => void run("restore")} type="button">
                Verify encrypted backup
              </button>
              <button className="button" disabled={busy} onClick={() => void run("initialize_confidential")} type="button">
                {setupSignature ? "Check reserve initialization status" : "Initialize confidential reserve"}
              </button>
            </>
          ) : null}
        </section>
      ) : (
        <section className="reserve-summary">
          <h2>Reserve key custody not configured</h2>
          <p>Configure encrypted custody for the reserve signing key. This action does not create or fund an on-chain confidential reserve.</p>
          {canInitialize ? (
            <button className="button" disabled={busy} onClick={() => void run("initialize")} type="button">
              Configure reserve key custody
            </button>
          ) : null}
        </section>
      )}
      <p className="notice">
        Paylore does not display reserve private keys, envelope secrets, provider API keys, database credentials, or session tokens.
      </p>
    </div>
  );
}
