"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { findAuthenticatedWallet } from "./authenticated-wallet";
import { ensureClaimAndCashOutAccount } from "./claim-and-cash-out-setup";
import { getClaimAndCashOutOutcome } from "./claim-and-cash-out-outcome";
import { ClaimAndCashOutStatus } from "./claim-and-cash-out-status";
import { BusyActionButton } from "./BusyActionButton";
import { assertConfidentialWithdrawalAvailable } from "./confidential-balance-policy";

import {
  applyConfidentialPendingBalance,
  closeConfidentialAccount,
  getConfidentialBalances,
  setupConfidentialAccount,
  unwrapWrappedUsdcToCircleUsdc,
  verifyWrappedUsdcUnwrapCompatibility,
  withdrawConfidentialBalance
} from "./confidential-account-transaction";

type AccountState = {
  ownerWalletAddress: string;
  tokenAccountAddress: string;
  status: string;
  setupTransactionSignature: string | null;
  closeTransactionSignature: string | null;
} | null;

type BalanceState = {
  availableBalance: bigint;
  pendingBalance: bigint;
  publicBalance: bigint;
} | null;

type ContributorBusyAction =
  | "setup"
  | "claim"
  | "refresh"
  | "apply"
  | "cashout"
  | "unwrap"
  | "leave"
  | "verify_setup"
  | "ledger";

type PayrollAllocation = {
  id: string;
  runId: string;
  runCreatedAt: string;
  amountBaseUnits: string;
  status: string;
  claimAddress: string | null;
  transactionSignature: string | null;
  claimedAt: string | null;
  recoveredAt: string | null;
  settlementSignature: string | null;
};

function formatUsdc(baseUnits: bigint): string {
  const whole = baseUnits / 1_000_000n;
  const fraction = (baseUnits % 1_000_000n)
    .toString()
    .padStart(6, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function parseUsdc(value: string): bigint {
  if (!/^(?:0|[1-9]\d*)(?:\.\d{1,6})?$/.test(value)) {
    throw new Error("Enter a positive USDC amount with up to six decimal places.");
  }
  const [whole, fraction = ""] = value.split(".");
  const amount =
    BigInt(whole) * 1_000_000n +
    BigInt((fraction + "000000").slice(0, 6));
  if (amount <= 0n) throw new Error("Enter a positive USDC amount.");
  return amount;
}

export function ContributorCompensation({
  workspaceId,
  walletAddress,
  mint,
  circleMint,
  tokenWrapProgramId,
  tokenWrapUnwrapEnabled,
  account,
  allocations,
  hasOpenAllocations,
  offboardingRequested
}: {
  workspaceId: string;
  walletAddress: string;
  mint: string | null;
  circleMint: string | null;
  tokenWrapProgramId: string;
  tokenWrapUnwrapEnabled: boolean;
  account: AccountState;
  allocations: PayrollAllocation[];
  hasOpenAllocations: boolean;
  offboardingRequested: boolean;
}) {
  const router = useRouter();
  const [currentAccount, setCurrentAccount] = useState(account);
  const [balance, setBalance] = useState<BalanceState>(null);
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [unwrapAmount, setUnwrapAmount] = useState("");
  const [closeSignature, setCloseSignature] = useState<string | null>(null);
  const [setupSignature, setSetupSignature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<ContributorBusyAction | null>(null);
  const [message, setMessage] = useState<{
    state: "success" | "error" | "partial";
    text: string;
  } | null>(null);
  const [cashOutLedgerRetry, setCashOutLedgerRetry] = useState<{
    kind: "confidential_withdrawal" | "circle_usdc_unwrap";
    signature: string;
    amountBaseUnits: string;
  } | null>(null);

  async function refreshConfidentialBalance(accountForRefresh: AccountState = currentAccount) {
    if (!mint || !accountForRefresh) {
      throw new Error("Set up a confidential account before checking its balance.");
    }
    const wallet = await findAuthenticatedWallet(walletAddress);
    const result = await getConfidentialBalances(
      wallet,
      mint,
      accountForRefresh.tokenAccountAddress
    );
    setBalance({
      availableBalance: result.availableBalance,
      pendingBalance: result.pendingBalance,
      publicBalance: result.publicBalance
    });
  }

  async function verifySetup(signature: string) {
    const response = await fetch(
      `/api/workspaces/${workspaceId}/contributors/me/confidential-account`,
      {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ signature })
      }
    );
    const result = await response.json();
    if (!response.ok || !result.account) {
      throw new Error(
        result.error === "confidential_account_not_ready"
          ? "The finalized transaction did not leave an approved confidential account enabled for incoming confidential credits. Paylore has not marked the account ready."
          : response.status === 503
            ? "The confidential account is not available on the configured USDC mint. No account status was recorded."
            : "The account transaction has not been verified as finalized. Keep its transaction reference and retry verification."
      );
    }
    setCurrentAccount(result.account);
    setSetupSignature(null);
    return result.account as NonNullable<AccountState>;
  }

  async function runSetup(manageBusy = true): Promise<boolean> {
    if (manageBusy && busy) return false;
    if (!mint) {
      setMessage({
        state: "error",
        text: "Confidential account setup is unavailable until the approved wrapped-USDC mint is initialized and configured."
      });
      return false;
    }
    if (
      !window.confirm(
        "Your wallet will sign the Token-2022 confidential-key derivation message and authorize account setup. Paylore does not receive or store the resulting keys. Use the same wallet for future confidential balance actions."
      )
    ) {
      setMessage({ state: "partial", text: "Confidential account setup was canceled. No account transaction was submitted." });
      return false;
    }
    if (manageBusy) {
      setBusy(true);
      setBusyAction("setup");
    } else {
      setBusyAction("setup");
    }
    setMessage({ state: "partial", text: "Preparing account… Approve the confidential-key derivation and account transaction in your wallet." });
    try {
      const wallet = await findAuthenticatedWallet(walletAddress);
      setMessage({
        state: "partial",
        text: "Checking the workspace Gas Tank and sponsorship policy… Your wallet remains the account owner."
      });
      const sponsorshipResponse = await fetch(
        `/api/workspaces/${workspaceId}/contributors/me/confidential-account/sponsorship`,
        { credentials: "same-origin", cache: "no-store" }
      );
      const sponsorshipResult = await sponsorshipResponse.json();
      if (!sponsorshipResponse.ok ||
          typeof sponsorshipResult.feePayerAddress !== "string" ||
          sponsorshipResult.mintAddress !== mint) {
        throw new Error(
          sponsorshipResult.error === "gas_tank_insufficient_balance"
            ? "The workspace Gas Tank needs funding before company-sponsored account setup can proceed."
            : "Company-sponsored account setup is unavailable under the current workspace policy. Paylore did not fall back to charging your wallet."
        );
      }
      const setup = await setupConfidentialAccount(wallet, mint, {
        feePayerAddress: sponsorshipResult.feePayerAddress,
        relayUrl: `/api/workspaces/${workspaceId}/contributors/me/confidential-account/sponsorship`
      });
      setSetupSignature(setup.signature);
      setMessage({
        state: "partial",
        text: "The account transaction is finalized. Paylore is verifying its Token-2022 state before recording setup."
      });
      const verifiedAccount = await verifySetup(setup.signature);
      await refreshConfidentialBalance(verifiedAccount);
      setMessage({ state: "success", text: "Confidential account ready" });
      return true;
    } catch (error) {
      setMessage({
        state: "error",
        text: error instanceof Error
          ? error.message
          : "Confidential account setup could not be completed."
      });
      return false;
    } finally {
      if (manageBusy) {
        setBusy(false);
        setBusyAction(null);
      } else {
        setBusyAction("claim");
      }
    }
  }

  async function runClaimAndCashOut() {
    if (busy) return;
    setBusy(true);
    setBusyAction("claim");
    setMessage({
      state: "partial",
      text: "Preparing your confidential account and payroll settlement…"
    });
    try {
      const setupOutcome = await ensureClaimAndCashOutAccount({
        accountReady: currentAccount?.status === "ready",
        setupAccount: () => runSetup(false)
      });
      if (setupOutcome === "account_setup_incomplete") return;
      let accountForBalance: AccountState = currentAccount;
      if (setupOutcome === "account_setup_completed") {
        const accountResponse = await fetch(
          `/api/workspaces/${workspaceId}/contributors/me/confidential-account`,
          { credentials: "same-origin", cache: "no-store" }
        );
        const accountResult = await accountResponse.json();
        if (!accountResponse.ok || !accountResult.account || accountResult.account.status !== "ready") {
          setMessage({ state: "error", text: "The confidential account is not verified as ready. No payroll transfer was attempted." });
          return;
        }
        accountForBalance = accountResult.account as NonNullable<AccountState>;
        setCurrentAccount(accountForBalance);
      }
      const eligible = allocations.filter((allocation) => allocation.status === "unclaimed" || allocation.status === "settlement_pending");
      if (eligible.length === 0) {
        setMessage({ state: "partial", text: "There are no unsettled payroll allocations available for this wallet." });
        return;
      }
      let settled = 0;
      let pending = 0;
      let failed = 0;
      let cleanupPending = 0;
      let stateConflict = false;
      setMessage({ state: "partial", text: "Preparing confidential payroll settlement…" });
      for (const allocation of eligible) {
        if (!allocation.claimAddress || !allocation.transactionSignature) { failed++; continue; }
        try {
          const response = await fetch(
            `/api/workspaces/${workspaceId}/payroll/runs/${allocation.runId}/allocations/${allocation.id}/claim`,
            { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" } }
          );
          const result = await response.json();
          if (!response.ok) { failed++; continue; }
          if (result.status === "claimed" || result.status === "already_settled") {
            settled++;
            if (result.warning === "proof_context_cleanup_pending") cleanupPending++;
          } else if (result.status === "workspace_busy") { pending++; break; }
          else if (result.status === "state_conflict") { stateConflict = true; break; }
          else if (result.status === "pending" || result.status === "retry_ready") pending++;
          else failed++;
        } catch { pending++; }
      }
      router.refresh();
      try { await refreshConfidentialBalance(accountForBalance); } catch { /* Chain state can finalize before the owner RPC catches up. */ }
      setMessage(getClaimAndCashOutOutcome({ settled, pending, failed, cleanupPending, stateConflict }));
    } catch (error) {
      setMessage({
        state: "error",
        text: error instanceof Error
          ? error.message
          : "Confidential payroll settlement could not be completed."
      });
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  async function recordCashOutLedger(
    kind: "confidential_withdrawal" | "circle_usdc_unwrap",
    signature: string,
    amountBaseUnits: string
  ): Promise<boolean> {
    try {
      const response = await fetch(`/api/workspaces/${workspaceId}/ledger/cash-out`, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind, signature, amountBaseUnits })
      });
      const result = await response.json();
      if (!response.ok || (result.status !== "finalized" && result.status !== "duplicate")) {
        throw new Error("Cash-out ledger reconciliation is not finalized.");
      }
      setCashOutLedgerRetry(null);
      return true;
    } catch {
      setCashOutLedgerRetry({ kind, signature, amountBaseUnits });
      setMessage({
        state: "partial",
        text: `The token movement finalized, but its workspace ledger entry is not reconciled. Do not submit a duplicate transaction. Transaction: ${signature}`
      });
      return false;
    }
  }

  async function retryCashOutLedger() {
    if (!cashOutLedgerRetry || busy) return;
    const pending = cashOutLedgerRetry;
    setBusy(true);
    setBusyAction("ledger");
    try {
      const reconciled = await recordCashOutLedger(
        pending.kind, pending.signature, pending.amountBaseUnits
      );
      if (reconciled) {
        setMessage({
          state: "success",
          text: `The previously submitted cash-out is now recorded in the workspace ledger. No new transaction was sent. Transaction: ${pending.signature}`
        });
      }
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  async function runBalanceAction(
    action: "refresh" | "apply" | "cashout" | "unwrap"
  ) {
    if (busy) return;
    if (cashOutLedgerRetry && (action === "cashout" || action === "unwrap")) {
      setMessage({
        state: "partial",
        text: "Reconcile the original finalized cash-out before submitting another token transaction."
      });
      return;
    }
    if (!mint || !currentAccount) return;
    setBusy(true);
    setBusyAction(action);
    setMessage({
      state: "partial",
      text: action === "apply"
        ? "Applying pending balance…"
        : action === "cashout"
          ? "Preparing public wrapped-USDC withdrawal…"
          : action === "unwrap"
            ? "Preparing Circle Devnet USDC unwrap…"
            : "Checking confidential account…"
    });
    try {
      const wallet = await findAuthenticatedWallet(walletAddress);
      if (action === "refresh") {
        await refreshConfidentialBalance();
        setMessage({ state: "success", text: "Confidential balance refreshed." });
        return;
      }
      if (action === "apply") {
        const signatures = await applyConfidentialPendingBalance(
          wallet,
          mint,
          currentAccount.tokenAccountAddress
        );
        await refreshConfidentialBalance();
        setMessage({
          state: "success",
          text: `Balance updated. Finalized transaction: ${signatures.at(-1)}`
        });
        return;
      }
      if (action === "unwrap") {
        if (!tokenWrapUnwrapEnabled) {
          throw new Error(
            "Circle Devnet USDC conversion is disabled by configuration. No unwrap transaction was submitted."
          );
        }
        if (!circleMint) {
          throw new Error(
            "Circle Devnet USDC is not configured. No unwrap transaction was submitted."
          );
        }
        const amount = parseUsdc(unwrapAmount);
        if (!balance || amount > balance.publicBalance) {
          throw new Error(
            "The requested amount is greater than the public wrapped-USDC balance."
          );
        }
        if (
          !window.confirm(
            `Unwrap ${formatUsdc(amount)} wrapped USDC into public Circle Devnet USDC in your wallet's token account? The wrapped tokens will be burned and the equivalent escrowed Circle USDC released. This operation and its amount are public on Solana.`
          )
        ) {
          setMessage({ state: "partial", text: "Unwrap canceled. No transaction was submitted." });
          return;
        }
        await verifyWrappedUsdcUnwrapCompatibility(wallet, mint, circleMint, tokenWrapProgramId, amount);
        if (!window.confirm(`Read-only compatibility checks and simulation succeeded for the exact unwrap plan. Unwrap ${formatUsdc(amount)} public wrapped USDC to Circle Devnet USDC? The amount and transaction are public on Solana.`)) {
          setMessage({ state: "partial", text: "Unwrap canceled. No transaction was submitted." });
          return;
        }
        const result = await unwrapWrappedUsdcToCircleUsdc(
          wallet, mint, circleMint, tokenWrapProgramId, amount
        );
        const ledgerRecorded = await recordCashOutLedger(
          "circle_usdc_unwrap", result.signature, amount.toString()
        );
        try { await refreshConfidentialBalance(); } catch { /* Finalized public balances may take time to appear on the owner RPC. */ }
        if (!ledgerRecorded) return;
        setMessage({
          state: "success",
          text: `Token Wrap finalized. Circle Devnet USDC was released to ${result.recipientTokenAccount} and recorded in the workspace ledger. The transaction is public on Solana: ${result.signature}`
        });
        return;
      }
      const amount = parseUsdc(withdrawAmount);
      if (!balance) {
        throw new Error("Refresh the confidential balance before withdrawing.");
      }
      assertConfidentialWithdrawalAvailable({
        amountBaseUnits: amount,
        availableBalance: balance.availableBalance,
        pendingBalance: balance.pendingBalance
      });
      if (
        !window.confirm(
          `Withdraw ${formatUsdc(amount)} wrapped USDC to your public wrapped-USDC token account? This does not convert it to Circle Devnet USDC. The withdrawal amount and transaction are public on Solana.`
        )
      ) {
        setMessage({ state: "partial", text: "Withdrawal canceled. No transaction was submitted." });
        return;
      }
      const signatures = await withdrawConfidentialBalance(
        wallet,
        mint,
        currentAccount.tokenAccountAddress,
        amount,
        6
      );
      const transactionSignature = signatures.at(-1);
      if (!transactionSignature) throw new Error("The confidential withdrawal did not return a transaction signature.");
      const ledgerRecorded = await recordCashOutLedger(
        "confidential_withdrawal", transactionSignature, amount.toString()
      );
      try { await refreshConfidentialBalance(); } catch { /* Finalized public balances may take time to appear on the owner RPC. */ }
      if (!ledgerRecorded) return;
      setMessage({
        state: "success",
        text: `Confidential withdrawal finalized and recorded in the workspace ledger. This credits public wrapped-USDC, not Circle Devnet USDC. The transaction is public on Solana. Transaction: ${transactionSignature}`
      });
    } catch (error) {
      setMessage({
        state: "error",
        text: error instanceof Error
          ? error.message
          : "The confidential account operation could not be completed."
      });
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  async function leaveWorkspace() {
    if (busy) return;
    if (
      !window.confirm(
        "Leaving removes your membership in this workspace. It does not transfer ownership of your confidential account to the organization. Confirm only after reviewing any outstanding compensation or pending transaction."
      )
    ) {
      setMessage({ state: "partial", text: "Workspace departure canceled. Your membership and confidential account are unchanged." });
      return;
    }
    setBusy(true);
    setBusyAction("leave");
    setMessage({
      state: "partial",
      text: currentAccount?.status === "ready"
        ? "Review closure and sign CloseAccount. Any eligible account rent is returned to your wallet."
        : "Leaving workspace…"
    });
    try {
      const preflightResponse = await fetch(
        `/api/workspaces/${workspaceId}/contributors/me/offboarding`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "preflight" })
        }
      );
      const preflight = await preflightResponse.json();
      if (!preflightResponse.ok) {
        throw new Error(
          preflight.error === "outstanding_compensation_obligation"
            ? "Workspace access cannot be removed while qualifying compensation obligations remain. No account-close transaction was sent."
            : "Paylore could not confirm that workspace departure is safe. No account-close transaction was sent."
        );
      }
      let transactionSignature = closeSignature;
      const wallet = await findAuthenticatedWallet(walletAddress);
      if (currentAccount?.status === "ready" && !transactionSignature) {
        if (!mint) throw new Error("The configured confidential mint is unavailable.");
        const signatures = await closeConfidentialAccount(
          wallet,
          mint,
          currentAccount.tokenAccountAddress,
          {
            ownerWalletAddress: currentAccount.ownerWalletAddress,
            accountStatus: currentAccount.status,
            hasOpenAllocations
          }
        );
        transactionSignature = signatures.at(-1) ?? null;
        setCloseSignature(transactionSignature);
      }
      const response = await fetch(
        `/api/workspaces/${workspaceId}/contributors/me/offboarding`,
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            acknowledgement: "Acknowledge & Leave Workspace",
            closeTransactionSignature: transactionSignature
          })
        }
      );
      const result = await response.json();
      if (!response.ok) {
        throw new Error(
          result.error === "outstanding_compensation_obligation"
            ? "Workspace access cannot be removed while qualifying compensation obligations remain. Contact the workspace administrator."
            : "The close transaction is not yet reconciled. Keep its transaction reference and retry the leave confirmation."
        );
      }
      if (wallet.disconnect) {
        try {
          await wallet.disconnect();
        } catch {
          // The post-leave view tells the contributor how to disconnect manually.
        }
      }
      const accountClosed = result.manualAccountClose === true;
      setMessage({
        state: "success",
        text: accountClosed
          ? "You have left the workspace and closed your confidential account through your wallet. Eligible rent was returned to your wallet."
          : "You have left the workspace. Your confidential account remains under your control and was not closed by Paylore."
      });
      router.replace(`/workspace/${workspaceId}/contributors/left`);
    } catch (error) {
      setMessage({
        state: "error",
        text: error instanceof Error
          ? error.message
          : "Workspace departure could not be completed."
      });
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  async function retrySetupVerification() {
    if (busy || !setupSignature) return;
    setBusy(true);
    setBusyAction("verify_setup");
    setMessage({ state: "partial", text: "Verifying the existing confidential account setup transaction…" });
    try {
      await verifySetup(setupSignature);
      setMessage({ state: "success", text: "Confidential account ready." });
    } catch {
      setMessage({ state: "partial", text: "The setup transaction is not yet verified. Keep the same reference and try again." });
    } finally {
      setBusy(false);
      setBusyAction(null);
    }
  }

  return (
    <div className="contributor-compensation">
      <section className="surface-card contributor-compensation__overview" aria-labelledby="compensation-heading">
        <header className="workspace-section-heading">
          <div>
            <p className="eyebrow">Your account</p>
            <h2 id="compensation-heading">Confidential account overview</h2>
            <p>Amounts shown here belong to your authenticated wallet. Pending and available balances are reported separately.</p>
          </div>
          <span className="subscription-status">
            {currentAccount?.status === "ready" ? "Account ready" : "Setup required"}
          </span>
        </header>
        <dl className="billing-period contributor-compensation__metrics">
          <div><dt>Account status</dt><dd>{currentAccount?.status === "ready" ? "Ready" : "Setup required"}</dd></div>
          <div><dt>Confidential account</dt><dd>{currentAccount?.tokenAccountAddress ?? "Not set up"}</dd></div>
          <div><dt>Pending confidential balance</dt><dd>{balance ? `${formatUsdc(balance.pendingBalance)} wrapped USDC` : "Refresh to check"}</dd></div>
          <div><dt>Available confidential balance</dt><dd>{balance ? `${formatUsdc(balance.availableBalance)} wrapped USDC` : "Refresh to check"}</dd></div>
          <div><dt>Public wrapped-USDC balance</dt><dd>{balance ? `${formatUsdc(balance.publicBalance)} wrapped USDC` : "Refresh to check"}</dd></div>
          <div><dt>Payroll period</dt><dd>Current workspace allocations</dd></div>
        </dl>
        {offboardingRequested ? (
          <p className="notice" role="status">
            Your workspace administrator asked you to review leaving this
            workspace. Resolve outstanding compensation and pending transactions
            before confirming departure.
          </p>
        ) : null}
        {!currentAccount || currentAccount.status !== "ready" ? (
          <p className="notice">
            Company-sponsored setup uses the workspace Gas Tank for approved account-creation rent and network costs. Your wallet derives confidential keys locally and authorizes the exact transaction; Paylore never receives those keys or owns the account. Start from Claim &amp; Cash Out when an allocation is available. Payroll creation alone never creates or funds a confidential account.
          </p>
        ) : (
          <div className="hero__actions">
            <BusyActionButton
              busy={busyAction === "refresh"}
              className="button button--secondary"
              disabled={busy}
              onClick={() => void runBalanceAction("refresh")}
              type="button"
            >
              {busyAction === "refresh" ? "Refreshing balance…" : "Refresh balance"}
            </BusyActionButton>
            <BusyActionButton
              busy={busyAction === "apply"}
              className="button button--secondary"
              disabled={busy}
              onClick={() => void runBalanceAction("apply")}
              type="button"
            >
              {busyAction === "apply" ? "Applying pending balance…" : "Apply pending balance"}
            </BusyActionButton>
          </div>
        )}
      </section>

      <section className="surface-card" aria-labelledby="payroll-allocations-heading">
        <header className="workspace-section-heading">
          <div>
            <p className="eyebrow">Payroll</p>
            <h2 id="payroll-allocations-heading">Recorded payroll allocations</h2>
            <p>Review allocations assigned to your wallet and the finalized state of each claim.</p>
          </div>
        </header>
        {allocations.some((allocation) => allocation.status !== "claimed" && allocation.status !== "recovered") ? (
          <div className="workspace-setup__content contributor-compensation__claim">
            <h3>Claim eligible payroll</h3>
            <p>This starts company-sponsored account setup when needed, then settles eligible allocations. Completion is shown only after finalized transfer and reserve reconciliation.</p>
            <BusyActionButton
              className="button"
              busy={busyAction === "claim" || busyAction === "setup"}
              disabled={busy || !mint}
              onClick={() => void runClaimAndCashOut()}
              type="button"
            >
              {busyAction === "setup"
                ? "Setting up confidential account…"
                : busyAction === "claim"
                  ? "Settling confidential payroll…"
                  : "Claim & Cash Out"}
            </BusyActionButton>
          </div>
        ) : null}
        {allocations.length === 0 ? (
          <div className="workspace-empty-state">
            <h3>No payroll allocations yet</h3>
            <p>When your workspace administrator records payroll for your wallet, the allocation and its claim status will appear here.</p>
          </div>
        ) : (
          <>
            <p className="notice">
              An unclaimed Claim PDA is an entitlement, not a payment. A claim is complete only after atomic confidential transfer, finalized Claim-PDA state, and reserve-balance reconciliation.
            </p>
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th scope="col">Payroll run</th>
                    <th scope="col">Wrapped-USDC allocation</th>
                    <th scope="col">Claim state</th>
                    <th scope="col">Claim PDA</th>
                  </tr>
                </thead>
                <tbody>
                  {allocations.map((allocation) => (
                    <tr key={allocation.id} data-testid={`payroll-allocation-${allocation.id}`}>
                      <td>
                        {new Date(allocation.runCreatedAt).toLocaleDateString()}
                        <br />
                        <code>{allocation.runId}</code>
                      </td>
                      <td>{formatUsdc(BigInt(allocation.amountBaseUnits))} wrapped USDC</td>
                      <td>
                        {allocation.status === "claimed"
                          ? `Settled${allocation.claimedAt ? ` on ${new Date(allocation.claimedAt).toLocaleString()}` : ""}${allocation.settlementSignature ? ` — ${allocation.settlementSignature}` : ""}`
                          : allocation.status === "recovered"
                            ? `Recovered${allocation.recoveredAt ? ` on ${new Date(allocation.recoveredAt).toLocaleString()}` : ""}`
                            : allocation.status === "settlement_pending"
                              ? `Settlement pending${allocation.settlementSignature ? ` — ${allocation.settlementSignature}` : ""}`
                              : "Unclaimed — no transfer recorded"}
                      </td>
                      <td>
                        {allocation.claimAddress ? (
                          <code>{allocation.claimAddress}</code>
                        ) : (
                          "Not recorded"
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </section>

      {setupSignature ? (
        <section className="state-callout" data-state="partial" role="status">
          <span className="state-callout__signal" aria-hidden="true" />
          <div>
            <p>Setup verification is pending. Transaction: <code>{setupSignature}</code></p>
            <BusyActionButton
              busy={busyAction === "verify_setup"}
              className="button button--secondary"
              disabled={busy}
              onClick={() => void retrySetupVerification()}
              type="button"
            >
              {busyAction === "verify_setup" ? "Verifying setup…" : "Verify setup"}
            </BusyActionButton>
          </div>
        </section>
      ) : null}

      {currentAccount?.status === "ready" ? (
        <section className="surface-card" aria-labelledby="account-movement-heading">
          <header className="workspace-section-heading">
            <div>
              <p className="eyebrow">Cash out</p>
              <h2 id="account-movement-heading">Move your confidential balance</h2>
              <p>Public withdrawals are visible on Solana. Choose the destination asset and review the amount before approving the wallet transaction.</p>
            </div>
          </header>
          <div className="workspace-quick-links__grid contributor-compensation__movement-grid">
            <section className="workspace-setup__content">
              <h3>Withdraw to public wrapped USDC</h3>
              <p>This moves the amount from your confidential available balance to your public wrapped-USDC token account. It does not convert to Circle Devnet USDC.</p>
              <label className="field">
                <span>Amount to withdraw (wrapped USDC)</span>
                <input
                  inputMode="decimal"
                  onChange={(event) => setWithdrawAmount(event.target.value)}
                  value={withdrawAmount}
                />
              </label>
              <BusyActionButton
                className="button"
                busy={busyAction === "cashout"}
                disabled={busy || cashOutLedgerRetry !== null || !balance || balance.availableBalance <= 0n}
                onClick={() => void runBalanceAction("cashout")}
                type="button"
              >
                {busyAction === "cashout" ? "Withdrawing wrapped USDC…" : "Withdraw wrapped USDC"}
              </BusyActionButton>
            </section>
            <section className="workspace-setup__content">
              <h3>Unwrap to public Circle Devnet USDC</h3>
              <p>Token Wrap burns public wrapped USDC from your wallet and releases the equivalent escrowed Circle Devnet USDC to your public legacy USDC token account. This conversion and its amount are visible on Solana.</p>
              {!tokenWrapUnwrapEnabled ? (
                <p role="status">
                  Circle Devnet USDC conversion is disabled by configuration. No unwrap transaction can be submitted.
                </p>
              ) : null}
              <label className="field">
                <span>Amount to unwrap (wrapped USDC)</span>
                <input
                  inputMode="decimal"
                  onChange={(event) => setUnwrapAmount(event.target.value)}
                  value={unwrapAmount}
                />
              </label>
              <BusyActionButton
                className="button button--secondary"
                busy={busyAction === "unwrap"}
                disabled={
                  busy ||
                  cashOutLedgerRetry !== null ||
                  !tokenWrapUnwrapEnabled ||
                  !balance ||
                  balance.publicBalance <= 0n ||
                  !circleMint
                }
                onClick={() => void runBalanceAction("unwrap")}
                type="button"
              >
                {busyAction === "unwrap"
                  ? "Unwrapping Circle Devnet USDC…"
                  : tokenWrapUnwrapEnabled
                    ? "Unwrap to Circle Devnet USDC"
                    : "Circle USDC conversion unavailable"}
              </BusyActionButton>
            </section>
          </div>
        </section>
      ) : null}

      <section className="surface-card contributor-compensation__departure" aria-labelledby="workspace-departure-heading">
        <h2 id="workspace-departure-heading">Workspace departure</h2>
        <p>Leaving removes your membership. It does not transfer ownership of your confidential account to the organization.</p>
        {hasOpenAllocations ? (
          <p className="notice" role="status">
            Workspace departure is unavailable while a qualifying compensation
            obligation remains unresolved.
          </p>
        ) : null}
        {currentAccount?.status === "ready" ? (
          <p className="notice">
            {balance?.publicBalance === 0n &&
            balance.pendingBalance === 0n &&
            balance.availableBalance === 0n
              ? "This confidential account has zero public, pending and available balances. Review the closure details before signing CloseAccount. Any eligible account rent is returned to the contributor-controlled destination."
              : "This account cannot be closed yet. Resolve every displayed public, pending and available balance before trying again."}
          </p>
        ) : null}
        <BusyActionButton
          className="button button--secondary"
          busy={busyAction === "leave"}
          disabled={busy || hasOpenAllocations || (currentAccount?.status === "ready" && (!balance || balance.publicBalance !== 0n || balance.availableBalance !== 0n || balance.pendingBalance !== 0n))}
          onClick={() => void leaveWorkspace()}
          type="button"
        >
          {busyAction === "leave" ? "Leaving workspace…" : "Acknowledge & Leave Workspace"}
        </BusyActionButton>
      </section>

      <ClaimAndCashOutStatus message={message} />
      {cashOutLedgerRetry ? (
        <div className="state-callout" data-state="partial" role="status">
          <span className="state-callout__signal" aria-hidden="true" />
          <p>The original transaction is saved for reconciliation. Retrying here does not submit another token transaction.</p>
          <BusyActionButton
            className="button button--secondary"
            busy={busyAction === "ledger"}
            disabled={busy}
            onClick={() => void retryCashOutLedger()}
            type="button"
          >
            {busyAction === "ledger" ? "Reconciling ledger…" : "Retry ledger reconciliation"}
          </BusyActionButton>
        </div>
      ) : null}
    </div>
  );
}
