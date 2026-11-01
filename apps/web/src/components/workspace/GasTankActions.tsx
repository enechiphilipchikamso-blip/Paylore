"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { isWalletCancellation } from "../auth/walletErrors";
import {
  findAuthenticatedWallet,
  reconnectAuthenticatedWallet,
  WALLET_RECONNECT_REQUIRED
} from "./authenticated-wallet";
import {
  createGasTankFundingTransaction,
  gasTankFundingSignature,
  signedGasTankFunding,
  solToLamports
} from "./gas-tank-funding-transaction";

type Notice = {
  state: "success" | "error" | "partial";
  text: string;
};

type PreparedFunding = {
  payer: string;
  destination: string;
  lamports: string;
  blockhash: string;
  lastValidBlockHeight: number;
};

type ReviewedFunding = PreparedFunding & {
  transaction: Uint8Array;
  expiresAt: number;
};

// A prepared blockhash stays valid for roughly 60 seconds; expire the review
// early so the wallet is never asked to sign a transaction that cannot land.
const PREPARED_FUNDING_TTL_MS = 45_000;
// Devnet usually finalizes a transfer within about 15 seconds; keep checking
// briefly before handing reconciliation to "Check funding transaction".
const FUNDING_FINALITY_ATTEMPTS = 12;
const FUNDING_FINALITY_INTERVAL_MS = 3_000;

function walletErrorReason(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? ` Wallet response: ${error.message.trim()}`
    : "";
}

function formatSol(lamports: string): string {
  const amount = BigInt(lamports);
  const whole = amount / 1_000_000_000n;
  const fraction = (amount % 1_000_000_000n)
    .toString()
    .padStart(9, "0")
    .replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function GasTankActions({
  workspaceId,
  walletAddress,
  gasTank,
  canManage,
  latestFunding,
  operations
}: {
  workspaceId: string;
  walletAddress: string;
  gasTank: {
    address: string;
    balanceLamports: string | null;
    lowBalance: boolean;
    balanceUnavailable: boolean;
    lastActivityAt: string | null;
    updatedAt: string;
  } | null;
  canManage: boolean;
  latestFunding: {
    signature: string;
    amountLamports: string | null;
    createdAt: string;
  } | null;
  operations: Array<{
    id: string;
    operationType: string;
    status: string;
    transactionSignature: string | null;
    feeLamports: string | null;
    failureCode: string | null;
    createdAt: string;
  }>;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [copyingAddress, setCopyingAddress] = useState(false);
  const [amount, setAmount] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [reviewedFunding, setReviewedFunding] = useState<ReviewedFunding | null>(null);
  const [reconnectRequired, setReconnectRequired] = useState(false);
  const [pendingFunding, setPendingFunding] = useState<{
    signature: string;
    lamports: string;
  } | null>(null);

  async function postAction(body: Record<string, string>) {
    return fetch(`/api/workspaces/${workspaceId}/gas-tank`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
  }

  async function configure(action: "initialize" | "restore") {
    setBusy(true);
    setNotice(null);
    try {
      const response = await postAction({ action });
      if (!response.ok) {
        setNotice({
          state: "error",
          text: action === "initialize"
            ? "Gas Tank setup could not be completed. Check the workspace status and try again."
            : "The Gas Tank backup could not be verified. No change has been confirmed."
        });
        return;
      }
      setNotice({
        state: "success",
        text: action === "initialize"
          ? "Gas Tank ready"
          : "The encrypted Gas Tank backup was verified and restored."
      });
      router.refresh();
    } catch {
      setNotice({
        state: "error",
        text: "The Gas Tank operation could not be completed. No success has been recorded."
      });
    } finally {
      setBusy(false);
    }
  }

  async function verifyFunding(
    signature: string,
    lamports: string
  ): Promise<"pending" | "settled"> {
    const response = await postAction({
      action: "verify_funding",
      signature,
      lamports
    });
    if (response.status === 202) {
      setNotice({
        state: "partial",
        text: "The transaction was submitted, but its final status is not confirmed yet. Paylore is checking the network before you retry."
      });
      return "pending";
    }
    if (!response.ok) {
      setNotice({
        state: "error",
        text: "The Gas Tank operation could not be completed. No success has been recorded. Check the operation details and try again."
      });
      return "settled";
    }
    setPendingFunding(null);
    setNotice({
      state: "success",
      text: "Gas Tank updated"
    });
    router.refresh();
    return "settled";
  }

  async function awaitFundingFinality(signature: string, lamports: string) {
    for (let attempt = 0; attempt < FUNDING_FINALITY_ATTEMPTS; attempt += 1) {
      if (await verifyFunding(signature, lamports) === "settled") return;
      await new Promise((resolve) =>
        window.setTimeout(resolve, FUNDING_FINALITY_INTERVAL_MS)
      );
    }
  }

  async function submitSignedFunding(
    prepared: ReviewedFunding,
    signedTransaction: Uint8Array
  ) {
    let signed: ReturnType<typeof signedGasTankFunding>;
    try {
      signed = signedGasTankFunding(
        prepared.transaction,
        signedTransaction,
        prepared.payer
      );
    } catch (error) {
      setNotice({
        state: "error",
        text: error instanceof Error
          ? error.message
          : "The wallet did not sign the funding transaction. No funding was sent."
      });
      return;
    }
    // The signature is known before submission, so any later uncertainty is
    // reconciled against this exact transaction instead of a new signature.
    setPendingFunding({ signature: signed.signature, lamports: prepared.lamports });
    let response: Response;
    try {
      response = await postAction({
        action: "submit_funding",
        transactionBase64: signed.transactionBase64,
        lamports: prepared.lamports
      });
    } catch {
      setNotice({
        state: "partial",
        text: "Paylore could not confirm that the signed funding transaction reached the network. Use Check funding transaction before signing again."
      });
      return;
    }
    if (response.status === 400 || response.status === 409) {
      setPendingFunding(null);
      const result = await response.json().catch(() => null) as { error?: string } | null;
      setNotice({
        state: "error",
        text: result?.error === "funding_transaction_rejected"
          ? "The network rejected the funding transaction, so no funding was sent. Check that the wallet holds enough Devnet SOL, then prepare the funding again."
          : "Paylore could not accept the signed funding transaction. No funding was sent. Refresh this page and prepare the funding again."
      });
      return;
    }
    if (!response.ok && response.status !== 202) {
      setNotice({
        state: "partial",
        text: "Paylore could not confirm that the signed funding transaction reached the network. Use Check funding transaction before signing again."
      });
      return;
    }
    await awaitFundingFinality(signed.signature, prepared.lamports);
  }

  function walletAvailable(): boolean {
    try {
      findAuthenticatedWallet(walletAddress);
      return true;
    } catch (error) {
      if (error instanceof Error && error.message === WALLET_RECONNECT_REQUIRED) {
        setReconnectRequired(true);
      }
      setNotice({
        state: "error",
        text: error instanceof Error ? error.message : WALLET_RECONNECT_REQUIRED
      });
      return false;
    }
  }

  async function reconnectWallet() {
    setBusy(true);
    setNotice(null);
    try {
      await reconnectAuthenticatedWallet(walletAddress);
      setReconnectRequired(false);
      setNotice({
        state: "success",
        text: "Wallet reconnected. You can fund the Gas Tank now."
      });
    } catch (error) {
      setNotice({
        state: isWalletCancellation(error) ? "partial" : "error",
        text: isWalletCancellation(error)
          ? "The wallet connection was cancelled."
          : error instanceof Error
            ? error.message
            : WALLET_RECONNECT_REQUIRED
      });
    } finally {
      setBusy(false);
    }
  }

  async function prepareFunding() {
    let lamports: string;
    try {
      lamports = solToLamports(amount);
    } catch (error) {
      setNotice({
        state: "error",
        text: error instanceof Error
          ? error.message
          : "Enter a valid SOL amount."
      });
      return;
    }

    setReviewedFunding(null);
    setNotice(null);
    if (!walletAvailable()) return;

    setBusy(true);
    try {
      const preparedResponse = await postAction({
        action: "prepare_funding",
        lamports
      });
      if (!preparedResponse.ok) {
        setNotice({
          state: "error",
          text: "Gas Tank funding could not be prepared. Check the workspace and network status before trying again."
        });
        return;
      }
      const prepared: PreparedFunding = await preparedResponse.json();
      if (
        prepared.payer !== walletAddress ||
        prepared.destination !== gasTank?.address ||
        prepared.lamports !== lamports
      ) {
        setNotice({
          state: "error",
          text: "The authenticated wallet or Gas Tank changed. Refresh this page before funding."
        });
        return;
      }
      setReviewedFunding({
        ...prepared,
        transaction: createGasTankFundingTransaction(prepared),
        expiresAt: Date.now() + PREPARED_FUNDING_TTL_MS
      });
    } catch (error) {
      setNotice({
        state: "error",
        text: error instanceof Error
          ? error.message
          : "Gas Tank funding could not be prepared."
      });
    } finally {
      setBusy(false);
    }
  }

  async function approveFunding() {
    const prepared = reviewedFunding;
    if (!prepared || busy) return;
    if (Date.now() >= prepared.expiresAt) {
      setReviewedFunding(null);
      setNotice({
        state: "partial",
        text: "The prepared funding expired. No funding was sent. Prepare it again before approving."
      });
      return;
    }

    let wallet: ReturnType<typeof findAuthenticatedWallet>;
    try {
      wallet = findAuthenticatedWallet(walletAddress);
    } catch (error) {
      setReviewedFunding(null);
      if (error instanceof Error && error.message === WALLET_RECONNECT_REQUIRED) {
        setReconnectRequired(true);
      }
      setNotice({
        state: "error",
        text: error instanceof Error ? error.message : WALLET_RECONNECT_REQUIRED
      });
      return;
    }
    if (wallet.account.address !== prepared.payer) {
      setReviewedFunding(null);
      setNotice({
        state: "error",
        text: "The authenticated wallet or Gas Tank changed. Refresh this page before funding."
      });
      return;
    }

    setBusy(true);
    setNotice(null);
    try {
      if (wallet.signTransaction) {
        // Prefer wallet signing with Paylore submission: a signing failure
        // always means nothing was broadcast, and the wallet does not need to
        // reach its own RPC before showing the approval prompt.
        let signedTransaction: Uint8Array;
        try {
          // The wallet request starts synchronously from this approval click.
          const [signed] = await wallet.signTransaction({
            account: wallet.account,
            transaction: prepared.transaction,
            chain: "solana:devnet",
            options: { preflightCommitment: "confirmed" }
          });
          if (!signed) {
            throw new Error("The wallet did not return a signed transaction.");
          }
          signedTransaction = signed.signedTransaction;
        } catch (error) {
          setNotice(isWalletCancellation(error)
            ? {
                state: "partial",
                text: "The wallet request was cancelled. No funding was sent."
              }
            : {
                state: "error",
                text: `The wallet could not sign the funding transaction. No funding was sent.${walletErrorReason(error)}`
              });
          return;
        }
        setReviewedFunding(null);
        await submitSignedFunding(prepared, signedTransaction);
        return;
      }

      let submissionStarted = false;
      try {
        submissionStarted = true;
        const submission = wallet.signAndSendTransaction({
          account: wallet.account,
          transaction: prepared.transaction,
          chain: "solana:devnet",
          options: { commitment: "confirmed" }
        });
        setReviewedFunding(null);
        const [sent] = await submission;
        if (!sent) {
          throw new Error("The wallet did not return a transaction signature.");
        }
        const signature = gasTankFundingSignature(sent.signature);
        setPendingFunding({ signature, lamports: prepared.lamports });
        submissionStarted = false;
        await awaitFundingFinality(signature, prepared.lamports);
      } catch (error) {
        if (isWalletCancellation(error)) {
          setNotice({
            state: "partial",
            text: "The wallet request was cancelled. No funding was sent."
          });
        } else if (submissionStarted) {
          setNotice({
            state: "partial",
            text: `The wallet did not confirm whether it sent the funding transaction. Check wallet activity before trying again.${walletErrorReason(error)}`
          });
        } else {
          setNotice({
            state: "error",
            text: error instanceof Error
              ? error.message
              : "Gas Tank funding could not be completed."
          });
        }
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="gas-tank-actions">
      {notice ? (
        <div
          className="state-callout"
          data-state={notice.state}
          role={notice.state === "error" ? "alert" : "status"}
          aria-live="polite"
        >
          <span className="state-callout__signal" aria-hidden="true" />
          <p>{notice.text}</p>
        </div>
      ) : null}
      {busy ? (
        <p className="loading-indicator" role="status" aria-live="polite">
          <span className="loading-indicator__icon" aria-hidden="true" />
          {pendingFunding
            ? "Confirming funding…"
            : reviewedFunding
              ? "Waiting for wallet approval…"
              : "Preparing Gas Tank…"}
        </p>
      ) : null}
      {!gasTank ? (
        <section className="reserve-summary">
          <h3>Gas Tank setup is required</h3>
          <p>Gas Tank setup is required before Paylore can sponsor supported operations.</p>
          {canManage ? (
            <button
              className="button"
              type="button"
              disabled={busy}
              aria-busy={busy}
              onClick={() => void configure("initialize")}
            >
              Set up Gas Tank
            </button>
          ) : null}
        </section>
      ) : (
        <>
          <section className="reserve-summary">
            <h3>Gas Tank ready</h3>
            <dl className="billing-period">
              <div>
                <dt>Gas Tank address</dt>
                <dd><code>{gasTank.address}</code></dd>
              </div>
              <div>
                <dt>Available network-fee balance</dt>
                <dd>{gasTank.balanceLamports === null
                  ? "Unavailable"
                  : `${formatSol(gasTank.balanceLamports)} SOL`}</dd>
              </div>
              <div>
                <dt>Low-balance threshold</dt>
                <dd>0.05 SOL</dd>
              </div>
              <div>
                <dt>Last activity</dt>
                <dd>{gasTank.lastActivityAt
                  ? new Date(gasTank.lastActivityAt).toLocaleString()
                  : "No activity recorded"}</dd>
              </div>
            </dl>
            <div className="action-row">
              <button
                className="button button--secondary"
                type="button"
                disabled={copyingAddress}
                aria-busy={copyingAddress}
                onClick={() => {
                  setCopyingAddress(true);
                  void navigator.clipboard.writeText(gasTank.address)
                    .then(() => setNotice({ state: "success", text: "Gas Tank address copied." }))
                    .catch(() => setNotice({ state: "error", text: "Could not copy the Gas Tank address. Select and copy it manually." }))
                    .finally(() => setCopyingAddress(false));
                }}
              >
                Copy address
              </button>
              {canManage ? (
                <button
                  className="button button--secondary"
                  type="button"
                  disabled={busy}
                  aria-busy={busy}
                  onClick={() => void configure("restore")}
                >
                  Verify encrypted backup
                </button>
              ) : null}
            </div>
            <a href="#gas-tank-operations">View operations</a>
          </section>
          {gasTank.lowBalance ? (
            <div className="state-callout" data-state="partial" role="status">
              <span className="state-callout__signal" aria-hidden="true" />
              <p>Gas Tank balance is low. Fund it before the next sponsored operation.</p>
            </div>
          ) : null}
          {canManage ? (
            <section className="reserve-summary" id="funding-transaction">
              <h3>Fund Gas Tank</h3>
              <p>
                Funding is manual. Paylore does not automatically refill this balance.
                Only SOL is accepted for network fees.
              </p>
              <label className="form-field">
                <span>Amount in SOL</span>
                <input
                  inputMode="decimal"
                  value={amount}
                  onChange={(event) => {
                    setAmount(event.target.value);
                    setReviewedFunding(null);
                  }}
                  aria-describedby="gas-tank-funding-help"
                />
              </label>
              <p className="notice" id="gas-tank-funding-help">
                The connected, authenticated workspace administrator wallet will
                sign a transfer to this Gas Tank address.
              </p>
              {reviewedFunding ? (
                <dl className="billing-period" aria-label="Review Gas Tank funding">
                  <div>
                    <dt>Amount</dt>
                    <dd>{formatSol(reviewedFunding.lamports)} SOL</dd>
                  </div>
                  <div>
                    <dt>Network</dt>
                    <dd>Solana Devnet</dd>
                  </div>
                  <div>
                    <dt>From</dt>
                    <dd><code>{reviewedFunding.payer}</code></dd>
                  </div>
                  <div>
                    <dt>Gas Tank</dt>
                    <dd><code>{reviewedFunding.destination}</code></dd>
                  </div>
                </dl>
              ) : null}
              <div className="action-row">
                {reconnectRequired ? (
                  <button
                    className="button"
                    type="button"
                    disabled={busy}
                    aria-busy={busy}
                    onClick={() => void reconnectWallet()}
                  >
                    Reconnect wallet
                  </button>
                ) : reviewedFunding ? (
                  <>
                    <button
                      className="button"
                      type="button"
                      disabled={busy}
                      aria-busy={busy}
                      onClick={() => void approveFunding()}
                    >
                      Open wallet to approve {formatSol(reviewedFunding.lamports)} SOL
                    </button>
                    <button
                      className="button button--secondary"
                      type="button"
                      disabled={busy}
                      onClick={() => setReviewedFunding(null)}
                    >
                      Cancel
                    </button>
                  </>
                ) : (
                  <button
                    className="button"
                    type="button"
                    disabled={busy || !walletAddress}
                    aria-busy={busy}
                    onClick={() => void prepareFunding()}
                  >
                    Fund Gas Tank
                  </button>
                )}
              </div>
            </section>
          ) : null}
        </>
      )}
      {pendingFunding ? (
        <button
          className="button button--secondary"
          type="button"
          disabled={busy}
          aria-busy={busy}
          onClick={() => {
            setBusy(true);
            void verifyFunding(
              pendingFunding.signature,
              pendingFunding.lamports
            ).finally(() => setBusy(false));
          }}
        >
          Check funding transaction
        </button>
      ) : null}
      <section className="reserve-summary">
        <h3>Funding transaction</h3>
        {latestFunding ? (
          <dl className="billing-period">
            <div>
              <dt>Status</dt>
              <dd>Finalized</dd>
            </div>
            <div>
              <dt>Amount</dt>
              <dd>{latestFunding.amountLamports
                ? `${formatSol(latestFunding.amountLamports)} SOL`
                : "—"}</dd>
            </div>
            <div>
              <dt>Transaction</dt>
              <dd>
                <a
                  href={`https://explorer.solana.com/tx/${encodeURIComponent(latestFunding.signature)}?cluster=devnet`}
                  target="_blank"
                  rel="noreferrer"
                >
                  View on Solana Explorer
                </a>
              </dd>
            </div>
            <div>
              <dt>Recorded</dt>
              <dd>{new Date(latestFunding.createdAt).toLocaleString()}</dd>
            </div>
          </dl>
        ) : (
          <p>No finalized funding transaction has been recorded.</p>
        )}
      </section>
      <section className="reserve-summary" id="gas-tank-operations" aria-labelledby="gas-tank-operations-heading">
        <h3 id="gas-tank-operations-heading">Gas Tank operations</h3>
        {operations.length > 0 ? (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Operation</th>
                  <th scope="col">Status</th>
                  <th scope="col">Network fee</th>
                  <th scope="col">Transaction</th>
                  <th scope="col">Created</th>
                </tr>
              </thead>
              <tbody>
                {operations.map((operation) => {
                  const statusLabel = operation.status === "finalized"
                    ? "Finalized"
                    : operation.status === "prepared"
                      ? "Prepared — awaiting wallet approval"
                      : operation.status === "preparing"
                        ? "Preparing…"
                        : operation.status === "cancelled"
                          ? "Cancelled"
                          : operation.status === "failed"
                            ? operation.failureCode === "finalized_chain_failure"
                              ? "Finalized with an on-chain failure"
                              : "Failed"
                            : operation.status;
                  return (
                    <tr key={operation.id}>
                      <td>{operation.operationType === "payroll_claim_commitment"
                        ? "Payroll Claim PDA creation"
                        : "Approved network operation"}</td>
                      <td>{statusLabel}</td>
                      <td>{operation.feeLamports && /^(0|[1-9][0-9]*)$/.test(operation.feeLamports)
                        ? `${formatSol(operation.feeLamports)} SOL`
                        : "Pending"}</td>
                      <td>{operation.transactionSignature ? (
                        <a href={`https://explorer.solana.com/tx/${encodeURIComponent(operation.transactionSignature)}?cluster=devnet`} target="_blank" rel="noreferrer">
                          View transaction
                        </a>
                      ) : "Not submitted"}</td>
                      <td>{new Date(operation.createdAt).toLocaleString()}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        ) : (
          <div className="workspace-empty-state">
            <h4>No sponsored operations yet</h4>
            <p>Approved workspace operations that use the Gas Tank will appear here with their finalized status and network fee.</p>
          </div>
        )}
        <p className="notice">
          Only approved workspace-scoped payroll Claim PDA creation is eligible for sponsorship.
          Other operations are not eligible for sponsored network fees.
        </p>
      </section>
    </div>
  );
}
