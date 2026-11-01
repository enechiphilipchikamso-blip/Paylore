"use client";

import Image from "next/image";
import {
  useEffect,
  useState,
  useSyncExternalStore,
  type ReactNode
} from "react";
import { useRouter } from "next/navigation";
import type {
  SolanaSignInInput,
  SolanaSignInOutput,
  SolanaSignMessageMethod
} from "@solana/wallet-standard-features";
import { SolanaSignMessage } from "@solana/wallet-standard-features";
import {
  isWalletCancellation
} from "./walletErrors";
import { MobileWalletAuthPanel } from "./MobileWalletAuthPanel";

const SUPPORTED_WALLET_OPTIONS = [
  {
    label: "Phantom",
    iconSrc: "/brand/wallets/phantom.svg",
    aliases: [
      "Phantom",
      "Phantom Wallet"
    ]
  },
  {
    label: "Solflare",
    iconSrc: "/brand/wallets/solflare.svg",
    aliases: [
      "Solflare",
      "Solflare Wallet"
    ]
  },
  {
    label: "Backpack",
    iconSrc: "/brand/wallets/backpack.png",
    aliases: [
      "Backpack",
      "Backpack Wallet"
    ]
  },
  {
    label: "Jupiter",
    iconSrc: "/brand/wallets/jupiter.svg",
    aliases: [
      "Jupiter",
      "Jupiter Wallet Extension",
      "Jupiter Wallet"
    ]
  }
] as const;

type StandardWallet = {
  name: string;
  features: Record<
    string,
    unknown
  >;
  accounts:
    readonly StandardAccount[];
};

type StandardAccount =
  SolanaSignInOutput["account"];

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
  ): Promise<
    readonly SolanaSignInOutput[]
  >;
};

type StandardSignMessageFeature = {
  signMessage: SolanaSignMessageMethod;
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

type WalletAuthPanelProps = AuthPanelProps & {
  walletCluster: string;
  backpackDeepLinkEnabled: boolean;
};

function AuthCardShell({ children }: { children: ReactNode }) {
  return (
    <div className="auth-card">
      <div className="auth-card__header">
        <h2>Sign in to Paylore</h2>
        <p>
          Connect with Phantom, Solflare, Backpack, or Jupiter. Then sign
          Paylore&apos;s authentication request. Connecting a wallet and
          signing in are separate steps.
        </p>
      </div>
      {children}
    </div>
  );
}

function requestMobileWalletAction(
  action: "connect" | "sign-in" | "disconnect",
  provider: "solflare" | "backpack"
): void {
  window.dispatchEvent(
    new CustomEvent("paylore:mobile-wallet-action", {
      detail: { action, provider }
    })
  );
}

type MobileWalletDisplayState = {
  account: { address: string; provider: "solflare" | "backpack" } | null;
  status: "idle" | "connecting" | "signing" | "success";
  error: string | null;
};

type ChallengeResponse = {
  nonce: string;
  input: SolanaSignInInput;
  message: string;
};

type VerifyPayload = {
  authMethod: "siws" | "message";
  nonce: string;
  walletAddress: string;
  publicKey: string;
  chains: string[];
  features: string[];
  signedMessage: string;
  signature: string;
};

function getStoredWallet(): string | null {
  try {
    const storedWallet = localStorage.getItem("paylore-last-wallet");
    return storedWallet &&
      SUPPORTED_WALLET_OPTIONS.some((option) => option.label === storedWallet)
      ? storedWallet
      : null;
  } catch {
    return null;
  }
}

function subscribeToStoredWallet(): () => void {
  return () => {};
}

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

function signMessageFeatureFor(
  wallet: StandardWallet
): StandardSignMessageFeature | null {
  const feature = wallet.features[SolanaSignMessage];
  if (
    !feature ||
    typeof feature !== "object" ||
    !("signMessage" in feature) ||
    typeof feature.signMessage !== "function"
  ) {
    return null;
  }

  return feature as StandardSignMessageFeature;
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

function WalletStandardAuthPanel({
  nextPath,
  reason,
  backpackDeepLinkEnabled
}: AuthPanelProps & { backpackDeepLinkEnabled: boolean }) {
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
    walletDiscoveryStatus,
    setWalletDiscoveryStatus
  ] = useState<
    "loading" | "ready" | "error"
  >("loading");

  const [
    walletDiscoveryAttempt,
    setWalletDiscoveryAttempt
  ] = useState(0);

  const [
    chooserOpen,
    setChooserOpen
  ] = useState(true);

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

  const storedWallet = useSyncExternalStore(
    subscribeToStoredWallet,
    getStoredWallet,
    () => null
  );
  const [lastUsedWalletOverride, setLastUsedWalletOverride] = useState<
    string | null
  >(null);
  const lastUsedWallet = lastUsedWalletOverride ?? storedWallet;

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
  const [mobileWalletState, setMobileWalletState] =
    useState<MobileWalletDisplayState>({
      account: null,
      status: "idle",
      error: null
    });

  useEffect(() => {
    const handleMobileWalletState = (event: Event) => {
      const detail = (event as CustomEvent<MobileWalletDisplayState>).detail;
      if (detail) {
        setMobileWalletState(detail);
        setChooserOpen(!detail.account);
      }
    };
    window.addEventListener("paylore:deeplink-wallet-state", handleMobileWalletState);
    return () => window.removeEventListener("paylore:deeplink-wallet-state", handleMobileWalletState);
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
            setWalletDiscoveryStatus("ready");
          }
        }
      )
      .catch(() => {
        if (active) {
          setWalletRegistry(null);
          setWalletDiscoveryStatus("error");
          setError(
            "Wallet discovery is unavailable. Try again."
          );
        }
      });

    return () => {
      active = false;
    };
  }, [walletDiscoveryAttempt]);

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
    Boolean((selectedWallet && account) || mobileWalletState.account);

  const displayedError = error ?? mobileWalletState.error;
  const failure = Boolean(displayedError);
  const operationStatus =
    mobileWalletState.status === "connecting" ||
    mobileWalletState.status === "signing" ||
    mobileWalletState.status === "success"
      ? mobileWalletState.status
      : status;

  const orderedWalletOptions = [
    ...SUPPORTED_WALLET_OPTIONS
  ].sort((left, right) => {
    if (left.label === lastUsedWallet) {
      return -1;
    }

    if (right.label === lastUsedWallet) {
      return 1;
    }

    return left.label.localeCompare(right.label);
  });

  function refreshWalletOptions() {
    if (!walletRegistry) {
      if (walletDiscoveryStatus === "error") {
        setError(null);
        setWalletDiscoveryStatus("loading");
        setWalletDiscoveryAttempt((attempt) => attempt + 1);
      }
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

      const walletLabel =
        getSupportedWalletLabel(wallet);

      if (walletLabel) {
        setLastUsedWalletOverride(walletLabel);
        try {
          localStorage.setItem(
            "paylore-last-wallet",
            walletLabel
          );
        } catch {
          setLastUsedWalletOverride(walletLabel);
        }
      }

      setStatus("idle");
    } catch (cause) {
      setStatus("idle");

      setError(
        isWalletCancellation(cause)
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
    const signMessageFeature =
      signMessageFeatureFor(selectedWallet);

    if (!signInFeature && !signMessageFeature) {
      setError(
        "This wallet cannot sign the Paylore authentication request. Connect a supported wallet that can sign in or sign a message."
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
          challengeResponse.status >= 500
            ? "Sign-in is temporarily unavailable. Please try again."
            : "Authentication failed. Please try again."
        );
      }

      let authMethod: VerifyPayload["authMethod"];
      let signedAccount: StandardAccount;
      let signedMessage: Uint8Array;
      let signature: Uint8Array;

      if (signInFeature) {
        const [output] = await signInFeature.signIn(challengeBody.input);
        if (
          !output?.account ||
          typeof output.account.address !== "string"
        ) {
          throw new Error(
            "The wallet returned an incomplete sign-in response. Reconnect your wallet and try again."
          );
        }
        authMethod = "siws";
        signedAccount = output.account;
        signedMessage = output.signedMessage;
        signature = output.signature;
      } else if (signMessageFeature) {
        const messageBytes = new TextEncoder().encode(challengeBody.message);
        const [output] = await signMessageFeature.signMessage({
          account,
          message: messageBytes
        });
        if (
          !output ||
          output.signature.length !== 64 ||
          (output.signatureType !== undefined &&
            output.signatureType !== "ed25519") ||
          output.signedMessage.length !== messageBytes.length ||
          !output.signedMessage.every(
            (byte, index) => byte === messageBytes[index]
          )
        ) {
          throw new Error(
            "The wallet did not sign the exact Paylore authentication message. Try signing in again."
          );
        }
        authMethod = "message";
        signedAccount = account;
        signedMessage = output.signedMessage;
        signature = output.signature;
      } else {
        throw new Error(
          "This wallet cannot sign the Paylore authentication request."
        );
      }

      if (signedAccount.address !== account.address) {
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
        authMethod,
        nonce:
          challengeBody.nonce,
        walletAddress:
          account.address,
        publicKey:
          bytesToBase64(
            signedAccount.publicKey
          ),
        chains: [
          ...signedAccount.chains
        ],
        features: [
          ...signedAccount.features
        ],
        signedMessage:
          bytesToBase64(signedMessage),
        signature:
          bytesToBase64(signature)
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
          verifyResponse.status >= 500
            ? "Sign-in is temporarily unavailable. Please try again."
            : "Authentication failed. Please try again."
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
        isWalletCancellation(cause)
          ? "Authentication was canceled."
          : cause instanceof Error
            ? cause.message
            : "Authentication failed. Please try again."
      );
    }
  }

  return (
    <>
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
          {connected ? (
            <>
              <strong>
                {selectedWallet
                  ? getSupportedWalletLabel(selectedWallet) ?? selectedWallet.name
                  : mobileWalletState.account?.provider === "solflare"
                    ? "Solflare"
                    : "Backpack"}
              </strong>
              <span>
                {truncateAddress(
                  account?.address ?? mobileWalletState.account?.address ?? ""
                )}
              </span>
              <small>Connected. Paylore sign-in is still required.</small>
            </>
          ) : (
            <>
              <strong>Wallet not connected</strong>
              <span>Choose one of the four supported wallets. Signing in is a separate step.</span>
            </>
          )}
        </div>
      </div>

      <div className="auth-actions">
        {!connected ? (
          <button
            className="button"
            type="button"
            onClick={
              refreshWalletOptions
            }
            disabled={
              status === "connecting" ||
              mobileWalletState.status === "connecting" ||
              mobileWalletState.status === "signing" ||
              walletDiscoveryStatus === "loading"
            }
          >
            {mobileWalletState.status === "connecting" || status === "connecting" ? (
              <span className="loading-indicator">
                <span
                  className="loading-indicator__icon"
                  aria-hidden="true"
                />
                Connecting…
              </span>
            ) : walletDiscoveryStatus === "loading" ? (
              <span className="loading-indicator">
                <span
                  className="loading-indicator__icon"
                  aria-hidden="true"
                />
                Discovering wallets…
              </span>
            ) : failure ? (
              "Try again"
            ) : (
              "Refresh wallet list"
            )}
          </button>
        ) : (
          <button
            className="button"
            type="button"
            onClick={() => {
              if (mobileWalletState.account) {
                requestMobileWalletAction("sign-in", mobileWalletState.account.provider);
              } else {
                void authenticate();
              }
            }}
            disabled={
              status === "signing" ||
              status === "success" ||
              mobileWalletState.status === "signing" ||
              mobileWalletState.status === "success"
            }
          >
            {failure ? (
              "Try again"
            ) : operationStatus === "signing" ? (
              <span className="loading-indicator">
                <span
                  className="loading-indicator__icon"
                  aria-hidden="true"
                />
                Signing…
              </span>
            ) : operationStatus === "success" ? (
              "Signed in"
            ) : (
              "Sign in with wallet"
            )}
          </button>
        )}

        {connected ? (
          <button
            className="button button--secondary"
            type="button"
            onClick={() => {
              if (mobileWalletState.account) {
                requestMobileWalletAction("disconnect", mobileWalletState.account.provider);
              } else {
                void disconnectWallet();
              }
            }}
            disabled={
              status === "signing" ||
              mobileWalletState.status === "signing"
            }
          >
            Disconnect wallet
          </button>
        ) : null}
      </div>

      {chooserOpen ? (
        <section
          className="wallet-chooser wallet-standard-chooser"
          aria-label="Connect wallet"
        >
          <div className="wallet-chooser__header">
            <div>
              <h3>Connect wallet</h3>
              <p>Connect with Phantom, Solflare, Backpack, or Jupiter.</p>
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
            {orderedWalletOptions.map(
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
                      status === "connecting" ||
                      mobileWalletState.status === "connecting" ||
                      mobileWalletState.status === "signing"
                    }
                    type="button"
                    aria-label={"Connect with " + option.label}
                    onClick={() => {
                      setError(null);
                      if (walletDiscoveryStatus === "loading") {
                        setError("Wallet discovery is still loading. Try again in a moment.");
                        return;
                      }
                      if (detectedWallet && connectFeatureFor(detectedWallet)) {
                        void connectWallet(detectedWallet);
                        return;
                      }
                      if (option.label === "Solflare") {
                        setChooserOpen(false);
                        requestMobileWalletAction("connect", "solflare");
                        return;
                      }
                      if (option.label === "Backpack" && backpackDeepLinkEnabled) {
                        setChooserOpen(false);
                        requestMobileWalletAction("connect", "backpack");
                        return;
                      }
                      setError(
                        option.label === "Backpack"
                          ? "Backpack could not connect in this browser. Open Paylore in the Backpack app browser or connect with the Backpack browser extension."
                          : option.label + " could not connect in this browser. Open Paylore in " + option.label + " or connect with its browser extension."
                      );
                    }}
                  >
                    <span
                      className="wallet-choice__icon"
                      aria-hidden="true"
                    >
                      <Image
                        src={option.iconSrc}
                        alt=""
                        width={44}
                        height={44}
                        unoptimized
                      />
                    </span>

                    <span className="wallet-choice__copy">
                      <span className="wallet-choice__name">
                        {option.label}
                      </span>

                      {option.label ===
                      lastUsedWallet ? (
                        <small className="wallet-choice__last-used">
                          <span
                            className="wallet-choice__last-used-signal"
                            aria-hidden="true"
                          />
                          Last used
                        </small>
                      ) : null}


                    </span>
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

      {displayedError ? (
        <div
          className="error-box"
          role="alert"
          aria-live="assertive"
        >
          {displayedError}
        </div>
      ) : null}
    </>
  );
}

export function WalletAuthPanel(props: WalletAuthPanelProps) {
  return (
    <AuthCardShell>
      <WalletStandardAuthPanel
        nextPath={props.nextPath}
        reason={props.reason}
        backpackDeepLinkEnabled={props.backpackDeepLinkEnabled}
      />
      <MobileWalletAuthPanel
        nextPath={props.nextPath}
        reason={props.reason}
        walletCluster={props.walletCluster}
        backpackDeepLinkEnabled={props.backpackDeepLinkEnabled}
      />
    </AuthCardShell>
  );
}
