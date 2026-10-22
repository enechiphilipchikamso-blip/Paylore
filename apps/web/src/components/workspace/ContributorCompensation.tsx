"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { findAuthenticatedWallet } from "./authenticated-wallet";
import {
  applyConfidentialPendingBalance,
  closeConfidentialAccount,
  getConfidentialBalances,
  setupConfidentialAccount,
  unwrapWrappedUsdcToCircleUsdc,
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

  async function runSetup() {
    if (!mint) {
      setMessage({
        state: "error",
        text: "Confidential account setup is unavailable until the approved wrapped-USDC mint is initialized and configured."
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

  async function runBalanceAction(
    action: "refresh" | "apply" | "cashout" | "unwrap"
  ) {
    if (!mint || !currentAccount) return;
    setBusy(true);
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
            "The Token Wrap operation is disabled until the deployed program ABI has been verified."
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
          setMessage(null);
          return;
        }
        const result = await unwrapWrappedUsdcToCircleUsdc(
          wallet,
          mint,
          circleMint,
          tokenWrapProgramId,
          amount
        );
        await refreshConfidentialBalance();
        setMessage({
          state: "success",
          text: `Token Wrap finalized. Circle Devnet USDC was released to ${result.recipientTokenAccount}. The transaction is public on Solana: ${result.signature}`
        });
        return;
      }
      const amount = parseUsdc(withdrawAmount);
      if (!balance || amount > balance.availableBalance) {
        throw new Error("The requested amount is greater than the available confidential balance.");
      }
      if (
        !window.confirm(
          `Withdraw ${formatUsdc(amount)} wrapped USDC to your public wrapped-USDC token account? This does not convert it to Circle Devnet USDC. The withdrawal amount and transaction are public on Solana.`
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
        text: `Confidential withdrawal finalized to the public wrapped-USDC token account. This is not Circle Devnet USDC; the transaction is public on-chain. Transaction: ${signatures.at(-1)}`
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
    }
  }

  return (
    <section className="surface-card" aria-labelledby="compensation-heading">
      <h2 id="compensation-heading">Your compensation</h2>
      <p>
        Review the wrapped-USDC allocations assigned to your wallet.
        Confidential balances use separate pending and available states.
      </p>
      <section aria-labelledby="payroll-allocations-heading">
        <h3 id="payroll-allocations-heading">Recorded payroll allocations</h3>
        {allocations.length === 0 ? (
          <p>No finalized payroll claim commitments are recorded for you.</p>
        ) : (
          <>
            <p className="notice">
              A recorded Claim PDA is an entitlement record, not a USDC
              transfer. Confidential payroll settlement and claim actions are
              not yet available.
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
                    <tr key={allocation.id}>
                      <td>
                        {new Date(allocation.runCreatedAt).toLocaleDateString()}
                        <br />
                        <code>{allocation.runId}</code>
                      </td>
                      <td>{formatUsdc(BigInt(allocation.amountBaseUnits))} wrapped USDC</td>
                      <td>
                        {allocation.status === "claimed"
                          ? `Claim PDA marked claimed — token transfer not verified${allocation.claimedAt ? ` on ${new Date(allocation.claimedAt).toLocaleString()}` : ""}`
                          : allocation.status === "recovered"
                            ? `Claim PDA marked recovered — reserve restoration not verified${allocation.recoveredAt ? ` on ${new Date(allocation.recoveredAt).toLocaleString()}` : ""}`
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
      <dl className="billing-period">
        <div><dt>Payroll period</dt><dd>Current workspace allocations</dd></div>
        <div><dt>Confidential account status</dt><dd>{currentAccount?.status === "ready" ? "Ready" : "Setup required"}</dd></div>
        <div><dt>Confidential account</dt><dd>{currentAccount?.tokenAccountAddress ?? "Not set up"}</dd></div>
        <div><dt>Pending confidential balance</dt><dd>{balance ? `${formatUsdc(balance.pendingBalance)} wrapped USDC` : "Refresh to check"}</dd></div>
        <div><dt>Available confidential balance</dt><dd>{balance ? `${formatUsdc(balance.availableBalance)} wrapped USDC` : "Refresh to check"}</dd></div>
        <div><dt>Public wrapped-USDC balance</dt><dd>{balance ? `${formatUsdc(balance.publicBalance)} wrapped USDC` : "Refresh to check"}</dd></div>
      </dl>
      {offboardingRequested ? (
        <p className="notice" role="status">
          Your workspace administrator asked you to review leaving this
          workspace. Resolve outstanding compensation and pending transactions
          before confirming departure.
        </p>
      ) : null}

      {!currentAccount || currentAccount.status !== "ready" ? (
        <>
        <p className="notice">
          Company-sponsored setup uses the workspace Gas Tank for approved account-creation rent and network costs. Your wallet derives confidential keys locally and authorizes the exact transaction; Paylore never receives those keys or owns the account. Setup occurs when you request it here, not when payroll creates a Claim PDA.
        </p>
        <button className="button" disabled={busy || !mint} onClick={() => void runSetup()} type="button">
          {busy ? "Preparing account…" : "Set up confidential account"}
        </button>
        </>
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
          <h3>Withdraw to public wrapped USDC</h3>
          <p>
            This moves the amount from your confidential available balance to
            the public token account for the configured wrapped-USDC mint. It
            does not unwrap to Circle Devnet USDC. The amount and transaction
            are public on Solana.
          </p>
          <label className="field">
            <span>Amount to withdraw (wrapped USDC)</span>
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
            Withdraw wrapped USDC
          </button>
        </div>
      ) : null}
      {currentAccount?.status === "ready" ? (
        <div className="surface-card">
          <h3>Unwrap to public Circle Devnet USDC</h3>
          <p>
            Token Wrap burns public wrapped USDC from your wallet and releases
            the equivalent escrowed Circle Devnet USDC to your public legacy
            USDC token account. This conversion and its amount are visible on
            Solana.
          </p>
          {!tokenWrapUnwrapEnabled ? (
            <p role="status">
              This action is disabled until the deployed Devnet Token Wrap
              program is verified to match the transaction builder.
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
          <button
            className="button button--secondary"
            disabled={
              busy ||
              !tokenWrapUnwrapEnabled ||
              !balance ||
              balance.publicBalance <= 0n ||
              !circleMint
            }
            onClick={() => void runBalanceAction("unwrap")}
            type="button"
          >
            {tokenWrapUnwrapEnabled
              ? "Unwrap to Circle Devnet USDC"
              : "Unwrap unavailable until program verification"}
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
          {balance?.publicBalance === 0n &&
          balance.pendingBalance === 0n &&
          balance.availableBalance === 0n
            ? "This confidential account has zero public, pending and available balances. Review the closure details before signing CloseAccount. Any eligible account rent is returned to the contributor-controlled destination."
            : "This account cannot be closed yet. Resolve every displayed public, pending and available balance before trying again."}
        </p>
      )}
      <button
        className="button button--secondary"
        disabled={busy || hasOpenAllocations || (currentAccount?.status === "ready" && (!balance || balance.publicBalance !== 0n || balance.availableBalance !== 0n || balance.pendingBalance !== 0n))}
        onClick={() => void leaveWorkspace()}
        type="button"
      >
        Acknowledge &amp; Leave Workspace
      </button>
      {!mint ? (
        <p className="notice">
          Confidential account setup is unavailable until an approved
          confidential wrapped-USDC mint is initialized and configured.
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
