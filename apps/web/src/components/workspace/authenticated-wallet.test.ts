import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  wallets: [] as Array<Record<string, any>>,
  getWallets: vi.fn()
}));

vi.mock("@wallet-standard/app", () => ({
  getWallets: mocks.getWallets
}));

import { SolanaSignAndSendTransaction } from "@solana/wallet-standard-features";
import {
  findAuthenticatedWallet,
  reconnectAuthenticatedWallet
} from "./authenticated-wallet";

const ADDRESS = "11111111111111111111111111111111";
const DEVNET = "solana:devnet";
const FEATURE = "solana:signAndSendTransaction";

function wallet(options: {
  name?: string;
  chains?: string[];
  supportedVersions?: Array<number | "legacy">;
  address?: string;
} = {}) {
  const signAndSendTransaction = vi.fn(async () => [{ signature: new Uint8Array(64) }]);
  const account = {
    address: options.address ?? ADDRESS,
    publicKey: new Uint8Array(32),
    chains: options.chains ?? [DEVNET],
    features: [FEATURE]
  };
  return {
    registered: {
      name: options.name ?? "Phantom",
      accounts: [account],
      features: {
        [SolanaSignAndSendTransaction]: {
          supportedTransactionVersions: options.supportedVersions ?? [0],
          signAndSendTransaction
        }
      }
    },
    signAndSendTransaction
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.wallets = [];
  mocks.getWallets.mockReturnValue({ get: () => mocks.wallets });
});

describe("findAuthenticatedWallet", () => {
  it("resolves the matching supported Devnet wallet synchronously for a direct approval click", () => {
    const registered = wallet();
    mocks.wallets = [registered.registered];

    const result = findAuthenticatedWallet(ADDRESS);

    expect(result).not.toBeInstanceOf(Promise);
    expect(result.account.address).toBe(ADDRESS);
    expect(result.account.chains).toEqual([DEVNET]);
    expect(result.signAndSendTransaction).toBe(registered.signAndSendTransaction);
  });

  it("rejects an account that is not registered for Devnet", () => {
    mocks.wallets = [wallet({ chains: ["solana:mainnet"] }).registered];

    expect(() => findAuthenticatedWallet(ADDRESS)).toThrow(
      "Reconnect the wallet you used to sign in, then try again."
    );
  });

  it("rejects a wallet without version-0 transaction support", () => {
    mocks.wallets = [wallet({ supportedVersions: ["legacy"] }).registered];

    expect(() => findAuthenticatedWallet(ADDRESS)).toThrow(
      "This wallet does not support a transaction on the selected Solana network."
    );
  });

  it("does not accept an unrelated wallet that has no matching supported name", () => {
    mocks.wallets = [wallet({ name: "Unrelated Wallet" }).registered];

    expect(() => findAuthenticatedWallet(ADDRESS)).toThrow(
      "Reconnect the wallet you used to sign in, then try again."
    );
  });
});

describe("reconnectAuthenticatedWallet", () => {
  function disconnectedWallet(name: string, address = ADDRESS) {
    const registered = wallet({ name, address }).registered;
    const account = registered.accounts[0];
    const state = { accounts: [] as typeof registered.accounts };
    const connect = vi.fn(async () => {
      state.accounts = [account];
      return { accounts: state.accounts };
    });
    const reloaded = {
      ...registered,
      get accounts() {
        return state.accounts;
      },
      features: { ...registered.features, "standard:connect": { connect } }
    };
    return { reloaded, connect };
  }

  it("reconnects the wallet after a reload so the authenticated account can sign again", async () => {
    const phantom = disconnectedWallet("Phantom");
    mocks.wallets = [phantom.reloaded];

    expect(() => findAuthenticatedWallet(ADDRESS)).toThrow(
      "Reconnect the wallet you used to sign in, then try again."
    );
    await reconnectAuthenticatedWallet(ADDRESS);

    expect(phantom.connect).toHaveBeenCalledTimes(1);
    expect(findAuthenticatedWallet(ADDRESS).account.address).toBe(ADDRESS);
  });

  it("does not prompt a wallet that already exposes the authenticated account", async () => {
    const phantom = disconnectedWallet("Phantom");
    await phantom.reloaded.features["standard:connect"].connect();
    phantom.connect.mockClear();
    mocks.wallets = [phantom.reloaded];

    await reconnectAuthenticatedWallet(ADDRESS);

    expect(phantom.connect).not.toHaveBeenCalled();
  });

  it("rejects a reconnected account that is not the signed-in wallet", async () => {
    mocks.wallets = [
      disconnectedWallet("Phantom", "So11111111111111111111111111111111111111112").reloaded
    ];

    await expect(reconnectAuthenticatedWallet(ADDRESS)).rejects.toThrow(
      "The connected wallet account is not the one you used to sign in."
    );
  });
});
