"use client";

import {
  useEffect,
  useState
} from "react";
import { useRouter } from "next/navigation";
import type {
  SolanaSignInInput,
  SolanaSignInOutput
} from "@solana/wallet-standard-features";

const SUPPORTED_WALLET_OPTIONS = [
  {
    label: "Phantom",
    aliases: [
      "Phantom",
      "Phantom Wallet"
    ]
  },
  {
    label: "Solflare",
    aliases: [
      "Solflare",
      "Solflare Wallet"
    ]
  },
  {
    label: "Backpack",
    aliases: [
      "Backpack",
      "Backpack Wallet"
    ]
  },
  {
    label:
      "Jupiter Wallet Extension",
    aliases: [
      "Jupiter Wallet Extension",
      "Jupiter Wallet"
    ]
  }
] as const;

type StandardWallet = {
  name: string;
  icon: string;
  features: Record<
    string,
    unknown
  >;
  accounts:
    readonly StandardAccount[];
};

type StandardAccount = {
  address: string;
  publicKey: ArrayLike<number>;
  chains: readonly string[];
  features: readonly string[];
};

type WalletRegistry = {
  get():
    | readonly StandardWallet[];
  on(
    event: "register" | "unregister",
    listener: (
      ...wallets: StandardWallet[]
    ) => void
  ): () => void;
};

type StandardConnectFeature = {
  connect(): Promise<{
    accounts:
      readonly StandardAccount[];
  }>;
};

type StandardSignInFeature = {
  signIn(
    input: SolanaSignInInput
  ): Promise<SolanaSignInOutput>;
};

type StandardDisconnectFeature = {
  disconnect():
    | void
    | Promise<void>;
};

type AuthPanelProps = {
  nextPath: string;
  reason?:
    | "inactivity-expired"
    | "hard-expired"
    | "logged-out";
};

type ChallengeResponse = {
  nonce: string;
  input: SolanaSignInInput;
  message: string;
};

type VerifyPayload = {
  nonce: string;
  walletAddress: string;
  publicKey: string;
  chains: string[];
  features: string[];
  signedMessage: string;
  signature: string;
};

function bytesToBase64(
  bytes: ArrayLike<number>
): string {
  const normalized =
    Uint8Array.from(bytes);

  let binary = "";

  const chunkSize = 0x8000;

  for (
    let offset = 0;
    offset < normalized.length;
    offset += chunkSize
  ) {
    binary += String.fromCharCode(
      ...normalized.slice(
        offset,
        offset + chunkSize
      )
    );
  }

  return btoa(binary);
}

function truncateAddress(
  value: string
): string {
  return `${value.slice(0, 5)}…${value.slice(-4)}`;
}

function reasonCopy(
  reason:
    | "inactivity-expired"
    | "hard-expired"
    | "logged-out"
    | undefined
): string | null {
  switch (reason) {
    case "inactivity-expired":
      return "Your session expired after 12 hours of inactivity. Sign again to continue.";
    case "hard-expired":
      return "Your session reached its 7-day maximum lifetime. Sign in again to continue.";
    case "logged-out":
      return "You have been signed out.";
    default:
      return null;
  }
}

function normalizeWalletName(
  name: string
): string {
  return name
    .trim()
    .toLowerCase()
    .replace(
      /\s+wallet(?:\s+extension)?$/,
      ""
    )
    .replace(
      /\s+extension$/,
      ""
    );
}

function getSupportedWalletLabel(
  wallet: StandardWallet
): string | null {
  const normalized =
    normalizeWalletName(
      wallet.name
    );

  const match =
    SUPPORTED_WALLET_OPTIONS.find(
      (option) =>
        option.aliases.some(
          (alias) =>
            normalizeWalletName(
              alias
            ) === normalized
        )
    );

  return (
    match?.label ?? null
  );
}

function isCancellation(
  cause: unknown
): boolean {
  if (!(cause instanceof Error)) {
    return false;
  }

  const value =
    `${cause.name} ${cause.message}`
      .toLowerCase();

  return (
    value.includes("reject") ||
    value.includes("cancel") ||
    value.includes("denied")
  );
}

function connectFeatureFor(
  wallet: StandardWallet
): StandardConnectFeature | null {
  if (
    !("standard:connect" in
      wallet.features)
  ) {
    return null;
  }

  return wallet.features[
    "standard:connect"
  ] as StandardConnectFeature;
}

function signInFeatureFor(
  wallet: StandardWallet
): StandardSignInFeature | null {
  if (
    !("solana:signIn" in
      wallet.features)
  ) {
    return null;
  }

  return wallet.features[
    "solana:signIn"
  ] as StandardSignInFeature;
}

function disconnectFeatureFor(
  wallet: StandardWallet
): StandardDisconnectFeature | null {
  if (
    !("standard:disconnect" in
      wallet.features)
  ) {
    return null;
  }

  return wallet.features[
    "standard:disconnect"
  ] as StandardDisconnectFeature;
}

export function WalletAuthPanel({
  nextPath,
  reason
}: AuthPanelProps) {
  const router = useRouter();

  const [
    walletRegistry,
    setWalletRegistry
  ] = useState<
    WalletRegistry | null
  >(null);

  const [
    walletOptions,
    setWalletOptions
  ] = useState<
    StandardWallet[]
  >([]);

  const [
    chooserOpen,
    setChooserOpen
  ] = useState(false);

  const [
    selectedWallet,
    setSelectedWallet
  ] = useState<
    StandardWallet | null
  >(null);

  const [account, setAccount] =
    useState<
      StandardAccount | null
    >(null);

  const [status, setStatus] =
    useState<
      | "idle"
      | "connecting"
      | "signing"
      | "success"
    >("idle");

  const [error, setError] =
    useState<string | null>(
      null
    );

  const [
    isMobileBrowser,
    setIsMobileBrowser
  ] = useState(false);

  useEffect(() => {
    const mobileQuery =
      window.matchMedia(
        "(max-width: 767px)"
      );

    const update = () => {
      setIsMobileBrowser(
        mobileQuery.matches ||
          /Android|iPhone|iPad|iPod|Mobile/i.test(
            navigator.userAgent
          )
      );
    };

    update();

    mobileQuery.addEventListener(
      "change",
      update
    );

    return () =>
      mobileQuery.removeEventListener(
        "change",
        update
      );
  }, []);

  useEffect(() => {
    let active = true;

    void import(
      "@wallet-standard/app"
    )
      .then(
        ({ getWallets }) => {
          if (active) {
            setWalletRegistry(
              getWallets() as WalletRegistry
            );
          }
        }
      )
      .catch(() => {
        if (active) {
          setWalletRegistry(null);
          setError(
            "Wallet discovery is unavailable. Try again."
          );
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    if (!walletRegistry) {
      return;
    }

    const refresh = () => {
      setWalletOptions(
        walletRegistry
          .get()
          .filter((wallet) =>
            getSupportedWalletLabel(
              wallet
            )
          ) as StandardWallet[]
      );
    };

    refresh();

    const offRegister =
      walletRegistry.on(
        "register",
        refresh
      );

    const offUnregister =
      walletRegistry.on(
        "unregister",
        refresh
      );

    return () => {
      offRegister();
      offUnregister();
    };
  }, [walletRegistry]);

  useEffect(() => {
    if (!selectedWallet) {
      return;
    }

    const events =
      selectedWallet.features[
        "standard:events"
      ] as
        | {
            on(
              event: "change",
              listener: (properties: {
                accounts?: readonly StandardAccount[];
              }) => void
            ): () => void;
          }
        | undefined;

    if (!events?.on) {
      return;
    }

    return events.on(
      "change",
      (properties) => {
        const nextAccount =
          properties.accounts?.[0] ??
          null;

        setAccount(nextAccount);

        if (!nextAccount) {
          setSelectedWallet(null);
          setStatus("idle");
        }
      }
    );
  }, [selectedWallet]);

  const notice =
    reasonCopy(reason);

  const connected =
    Boolean(
      selectedWallet &&
        account
    );

  const failure =
    Boolean(error);

  function refreshWalletOptions() {
    if (!walletRegistry) {
      setError(
        "Wallet discovery is still loading. Try again."
      );
      return;
    }

    const supported =
      walletRegistry
        .get()
        .filter(
          (wallet) =>
            getSupportedWalletLabel(
              wallet
            )
        ) as StandardWallet[];

    setWalletOptions(
      supported
    );

    setChooserOpen(true);
    setError(null);
  }

  async function connectWallet(
    wallet: StandardWallet
  ) {
    const connectFeature =
      connectFeatureFor(wallet);

    if (!connectFeature) {
      setChooserOpen(false);
      setError(
        "This wallet is not supported by the Paylore application."
      );
      return;
    }

    setChooserOpen(false);
    setError(null);
    setStatus("connecting");

    try {
      const result =
        await connectFeature.connect();

      const nextAccount =
        result.accounts[0];

      if (!nextAccount) {
        throw new Error(
          "Connection did not provide a wallet account."
        );
      }

      setSelectedWallet(
        wallet
      );

      setAccount(
        nextAccount
      );

      setStatus("idle");
    } catch (cause) {
      setStatus("idle");

      setError(
        isCancellation(cause)
          ? "Connection canceled"
          : "Connection failed. Try again."
      );
    }
  }

  async function disconnectWallet() {
    if (selectedWallet) {
      const disconnectFeature =
        disconnectFeatureFor(
          selectedWallet
        );

      if (disconnectFeature) {
        try {
          await disconnectFeature.disconnect();
        } catch {
          // Clearing local state prevents a stale account from being reused for authentication.
        }
      }
    }

    setSelectedWallet(null);
    setAccount(null);
    setStatus("idle");
    setError(null);
  }

  async function authenticate() {
    if (!selectedWallet || !account) {
      refreshWalletOptions();
      return;
    }

    const signInFeature =
      signInFeatureFor(
        selectedWallet
      );

    if (!signInFeature) {
      setError(
        "This wallet does not provide the required sign-in capability."
      );
      return;
    }

    setError(null);
    setStatus("signing");

    try {
      const challengeResponse =
        await fetch(
          "/api/auth/challenge",
          {
            method: "POST",
            headers: {
              "content-type":
                "application/json"
            },
            credentials:
              "same-origin",
            body: JSON.stringify({
              walletAddress:
                account.address
            })
          }
        );

      const challengeBody =
        (await challengeResponse.json()) as
          | ChallengeResponse
          | { error: string };

      if (
        !challengeResponse.ok ||
        !("nonce" in
          challengeBody)
      ) {
        throw new Error(
          "Authentication failed. Try again."
        );
      }

      const output =
        await signInFeature.signIn(
          challengeBody.input
        );

      if (
        output.account.address !==
        account.address
      ) {
        setSelectedWallet(
          null
        );
        setAccount(null);
        setError(
          "Wallet changed. Reconnect and sign in again."
        );
        setStatus("idle");
        return;
      }

      const verifyPayload:
        VerifyPayload = {
        nonce:
          challengeBody.nonce,
        walletAddress:
          account.address,
        publicKey:
          bytesToBase64(
            output.account.publicKey
          ),
        chains: [
          ...output.account.chains
        ],
        features: [
          ...output.account.features
        ],
        signedMessage:
          bytesToBase64(
            output.signedMessage
          ),
        signature:
          bytesToBase64(
            output.signature
          )
      };

      const verifyResponse =
        await fetch(
          "/api/auth/verify",
          {
            method: "POST",
            headers: {
              "content-type":
                "application/json"
            },
            credentials:
              "same-origin",
            body: JSON.stringify(
              verifyPayload
            )
          }
        );

      if (!verifyResponse.ok) {
        throw new Error(
          "Authentication failed. Try again."
        );
      }

      setStatus("success");

      router.replace(
        nextPath
      );

      router.refresh();
    } catch (cause) {
      setStatus("idle");

      setError(
        isCancellation(cause)
          ? "Authentication was canceled."
          : cause instanceof Error
            ? cause.message
            : "Authentication failed. Try again."
      );
    }
  }

  return (
    <div className="auth-card">
      <div className="auth-card__header">
        <p className="eyebrow">
          SECURE ENTRY
        </p>

        <h2>
          Sign in to Paylore
        </h2>

        <p>
          Connect one of the
          supported Solana wallets
          and sign the Paylore
          authentication request.
          This signature proves
          wallet control; it does
          not send payroll funds or
          a payroll transaction.
        </p>
      </div>

      {notice ? (
        <div
          className="notice"
          role="status"
          aria-live="polite"
        >
          {notice}
        </div>
      ) : null}

      <div className="auth-status">
        <span
          className="status-indicator"
          data-connected={
            connected
              ? "true"
              : "false"
          }
        />

        <div className="auth-status__copy">
          {connected &&
          account &&
          selectedWallet ? (
            <>
              <strong>
                {
                  getSupportedWalletLabel(
                    selectedWallet
                  ) ??
                  selectedWallet.name
                }
              </strong>

              <span>
                {truncateAddress(
                  account.address
                )}
              </span>

              <small>
                Connected. Paylore
                sign-in is still required.
              </small>
            </>
          ) : (
            <>
              <strong>
                No wallet is connected
              </strong>

              <span>
                Connection and
                authentication are
                separate steps.
              </span>
            </>
          )}
        </div>
      </div>

      {isMobileBrowser ? (
        <div className="mobile-wallet-notice">
          <p>
            Paylore wallet connection
            for the MVP requires a
            desktop browser with
            Phantom, Solflare,
            Backpack, or Jupiter
            Wallet Extension.
          </p>

          <p>
            Open Paylore in a desktop
            browser to connect your
            wallet.
          </p>
        </div>
      ) : (
        <div className="auth-actions">
          {!connected ? (
            <button
              className="button"
              type="button"
              onClick={
                refreshWalletOptions
              }
              disabled={
                status ===
                "connecting"
              }
            >
              {failure
                ? "Try again"
                : status ===
                    "connecting"
                  ? "Connecting…"
                  : "Connect wallet"}
            </button>
          ) : (
            <button
              className="button"
              type="button"
              onClick={() =>
                void authenticate()
              }
              disabled={
                status ===
                  "signing" ||
                status ===
                  "success"
              }
            >
              {failure
                ? "Try again"
                : status ===
                    "signing"
                  ? "Signing…"
                  : status ===
                      "success"
                    ? "Signed in"
                    : "Sign in with wallet"}
            </button>
          )}

          {connected ? (
            <button
              className="button button--secondary"
              type="button"
              onClick={() =>
                void disconnectWallet()
              }
              disabled={
                status === "signing"
              }
            >
              Disconnect wallet
            </button>
          ) : null}
        </div>
      )}

      {chooserOpen &&
      !isMobileBrowser ? (
        <section
          className="wallet-chooser"
          aria-label="Choose a supported wallet"
        >
          <div className="wallet-chooser__header">
            <div>
              <h3>
                Choose your wallet
              </h3>

              <p>
                Only the four wallets
                supported by Paylore are
                shown.
              </p>
            </div>

            <button
              className="wallet-chooser__close"
              type="button"
              aria-label="Close wallet chooser"
              onClick={() =>
                setChooserOpen(
                  false
                )
              }
            >
              ×
            </button>
          </div>

          <div className="wallet-choices">
            {SUPPORTED_WALLET_OPTIONS.map(
              (option) => {
                const detectedWallet =
                  walletOptions.find(
                    (wallet) =>
                      getSupportedWalletLabel(
                        wallet
                      ) ===
                      option.label
                  );

                return (
                  <button
                    className="wallet-choice"
                    key={
                      option.label
                    }
                    disabled={
                      !detectedWallet
                    }
                    type="button"
                    onClick={() => {
                      if (
                        detectedWallet
                      ) {
                        void connectWallet(
                          detectedWallet
                        );
                      }
                    }}
                  >
                    <span>
                      {option.label}
                    </span>

                    <small>
                      {detectedWallet
                        ? "Available"
                        : "Not detected"}
                    </small>
                  </button>
                );
              }
            )}
          </div>
        </section>
      ) : null}

      <p className="auth-security-note">
        Signing in is an
        authentication action. It
        does not send payroll funds.
      </p>

      {error ? (
        <div
          className="error-box"
          role="alert"
          aria-live="assertive"
        >
          {error}
        </div>
      ) : null}
    </div>
  );
}