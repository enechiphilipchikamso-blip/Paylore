"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { findAuthenticatedWallet } from "./authenticated-wallet";
import {
  applyConfidentialPendingBalance,
  closeConfidentialAccount,
  getConfidentialBalances,
  setupConfidentialAccount,
  withdrawConfidentialBalance
} from "./confidential-account-transaction";

type AccountState = {
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
  account,
  hasOpenAllocations,
  offboardingRequested
}: {
  workspaceId: string;
  walletAddress: string;
  mint: string | null;
  account: AccountState;
  hasOpenAllocations: boolean;
  offboardingRequested: boolean;
}) {
  const router = useRouter();
  const [currentAccount, setCurrentAccount] = useState(account);
  const [balance, setBalance] = useState<BalanceState>(null);
  const [withdrawAmount, setWithdrawAmount] = useState("");
  const [closeSignature, setCloseSignature] = useState<string | null>(null);
  const [setupSignature, setSetupSignature] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{
    state: "success" | "error" | "partial";
    text: string;
  } | null>(null);

  async function refreshConfidentialBalance() {
    if (!mint || !currentAccount) {
      throw new Error("Set up a confidential account before checking its balance.");
    }
    const wallet = await findAuthenticatedWallet(walletAddress);
    const result = await getConfidentialBalances(
      wallet,
      mint,
      currentAccount.tokenAccountAddress
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
        response.status === 503
          ? "The confidential account is not available on the configured Devnet mint. No account status was recorded."
          : "The account transaction has not been verified as finalized. Keep its transaction reference and retry verification."
      );
    }
    setCurrentAccount(result.account);
    setSetupSignature(null);
    return result.account as NonNullable<AccountState>;
  }

  async function runSetup() {
    if (!mint) {
      setMessage({
        state: "error",
        text: "Confidential account setup is unavailable until the official wrapped-USDC Devnet mint is initialized and configured."
      });
      return;
    }
    if (
      !window.confirm(
        "Your wallet will sign the Token-2022 confidential-key derivation message and authorize account setup. Paylore does not receive or store the resulting keys. Use the same wallet for future confidential balance actions."
      )
    ) return;
    setBusy(true);
    setMessage({ state: "partial", text: "Preparing account… Approve the confidential-key derivation and account transaction in your wallet." });
    try {
      const wallet = await findAuthenticatedWallet(walletAddress);
      const setup = await setupConfidentialAccount(wallet, mint);
      setSetupSignature(setup.signature);
      setMessage({
        state: "partial",
        text: "The account transaction is finalized. Paylore is verifying its Token-2022 state before recording setup."
      });
      await verifySetup(setup.signature);
      await refreshConfidentialBalance();
      setMessage({ state: "success", text: "Confidential account ready" });
    } catch (error) {
      setMessage({
        state: "error",
        text: error instanceof Error
          ? error.message
          : "Confidential account setup could not be completed."
      });
    } finally {
      setBusy(false);
    }
  }

  async function runBalanceAction(action: "refresh" | "apply" | "cashout") {
    if (!mint || !currentAccount) return;
    setBusy(true);
    setMessage({
      state: "partial",
      text: action === "apply"
        ? "Applying pending balance…"
        : action === "cashout"
          ? "Preparing cash-out…"
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
      const amount = parseUsdc(withdrawAmount);
      if (!balance || amount > balance.availableBalance) {
        throw new Error("The requested amount is greater than the available confidential balance.");
      }
      if (
        !window.confirm(
          `Cash out ${formatUsdc(amount)} USDC to your public USDC balance? The withdrawal amount and resulting public transaction are visible according to Solana network behavior.`
        )
      ) {
        setMessage(null);
        return;
      }
      const signatures = await withdrawConfidentialBalance(
        wallet,
        mint,
        currentAccount.tokenAccountAddress,
        amount,
        6
      );
      await refreshConfidentialBalance();
      setMessage({
        state: "success",
        text: `Cash-out finalized. Public USDC balance and transaction are visible on-chain. Transaction: ${signatures.at(-1)}`
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
    }
  }

  async function leaveWorkspace() {
    if (
      !window.confirm(
        "Leaving removes your membership in this workspace. It does not transfer ownership of your confidential account to the organization. Confirm only after reviewing any outstanding compensation or pending transaction."
      )
    ) return;
    setBusy(true);
    setMessage({
      state: "partial",
      text: currentAccount?.status === "ready"
        ? "Review closure and sign CloseAccount. Any eligible account rent is returned to your wallet."
        : "Leaving workspace…"
    });
    try {
      let transactionSignature = closeSignature;
      const wallet = await findAuthenticatedWallet(walletAddress);
      if (currentAccount?.status === "ready" && !transactionSignature) {
        if (!mint) throw new Error("The configured confidential mint is unavailable.");
        const signatures = await closeConfidentialAccount(
          wallet,
          mint,
          currentAccount.tokenAccountAddress
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
      setMessage({
        state: "success",
        text: "You have left the workspace. Your confidential account remains under your control."
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
    }
  }

  return (
    <section className="surface-card" aria-labelledby="compensation-heading">
      <h2 id="compensation-heading">Your compensation</h2>
      <p>
        Review the USDC compensation assigned to your wallet. Confidential
        balances use separate pending and available states.
      </p>
      <dl className="billing-period">
        <div><dt>Payroll period</dt><dd>Current workspace allocations</dd></div>
        <div><dt>Claim status</dt><dd>{currentAccount?.status === "ready" ? "Confidential account ready" : "Account setup required"}</dd></div>
        <div><dt>Confidential account</dt><dd>{currentAccount?.tokenAccountAddress ?? "Not set up"}</dd></div>
        <div><dt>Pending confidential balance</dt><dd>{balance ? `${formatUsdc(balance.pendingBalance)} USDC` : "Refresh to check"}</dd></div>
        <div><dt>Available confidential balance</dt><dd>{balance ? `${formatUsdc(balance.availableBalance)} USDC` : "Refresh to check"}</dd></div>
        <div><dt>Public USDC balance</dt><dd>{balance ? `${formatUsdc(balance.publicBalance)} USDC` : "Refresh to check"}</dd></div>
      </dl>
      {offboardingRequested ? (
        <p className="notice" role="status">
          Your workspace administrator asked you to review leaving this
          workspace. Resolve outstanding compensation and pending transactions
          before confirming departure.
        </p>
      ) : null}

      {!currentAccount || currentAccount.status !== "ready" ? (
        <button className="button" disabled={busy || !mint} onClick={() => void runSetup()} type="button">
          {busy ? "Preparing account…" : "Set up confidential account"}
        </button>
      ) : (
        <div className="hero__actions">
          <button className="button button--secondary" disabled={busy} onClick={() => void runBalanceAction("refresh")} type="button">
            Refresh balance
          </button>
          <button className="button button--secondary" disabled={busy} onClick={() => void runBalanceAction("apply")} type="button">
            Apply pending balance
          </button>
        </div>
      )}

      {setupSignature ? (
        <div className="state-callout" data-state="partial" role="status">
          <span className="state-callout__signal" aria-hidden="true" />
          <p>Setup verification is pending. Transaction: <code>{setupSignature}</code></p>
          <button className="button button--secondary" disabled={busy} onClick={() => {
            setBusy(true);
            void verifySetup(setupSignature)
              .then(() => setMessage({ state: "success", text: "Confidential account ready" }))
              .catch(() => setMessage({ state: "partial", text: "The setup transaction is not yet verified. Keep the same reference and try again." }))
              .finally(() => setBusy(false));
          }} type="button">
            Verify setup
          </button>
        </div>
      ) : null}

      {currentAccount?.status === "ready" ? (
        <div className="surface-card">
          <h3>Cash out</h3>
          <p>
            Cash out moves this amount from your confidential available balance
            to a public USDC balance. The resulting public balance and
            blockchain transaction are visible according to Solana network behavior.
          </p>
          <label className="field">
            <span>Amount to cash out (USDC)</span>
            <input
              inputMode="decimal"
              onChange={(event) => setWithdrawAmount(event.target.value)}
              value={withdrawAmount}
            />
          </label>
          <button
            className="button"
            disabled={busy || !balance || balance.availableBalance <= 0n}
            onClick={() => void runBalanceAction("cashout")}
            type="button"
          >
            Cash out
          </button>
        </div>
      ) : null}

      {hasOpenAllocations ? (
        <p className="notice" role="status">
          Workspace departure is unavailable while a qualifying compensation
          obligation remains unresolved.
        </p>
      ) : null}
      {currentAccount?.status === "ready" && (
        <p className="notice">
          {balance?.availableBalance === 0n && balance.pendingBalance === 0n
            ? "This confidential account has no balance available for transfer. Review the closure details before signing CloseAccount. Any eligible account rent is returned to the contributor-controlled destination."
            : "This account cannot be closed yet. Resolve the displayed balance or pending operation before trying again."}
        </p>
      )}
      <button
        className="button button--secondary"
        disabled={busy || hasOpenAllocations || (currentAccount?.status === "ready" && (!balance || balance.availableBalance !== 0n || balance.pendingBalance !== 0n))}
        onClick={() => void leaveWorkspace()}
        type="button"
      >
        Acknowledge &amp; Leave Workspace
      </button>
      {!mint ? (
        <p className="notice">
          Confidential account setup and settlement are unavailable until an
          official confidential wrapped-USDC Devnet mint is initialized and configured.
        </p>
      ) : null}
      {message ? (
        <div className="state-callout" data-state={message.state} role={message.state === "error" ? "alert" : "status"}>
          <span className="state-callout__signal" aria-hidden="true" />
          <p>{message.text}</p>
        </div>
      ) : null}
    </section>
  );
}
