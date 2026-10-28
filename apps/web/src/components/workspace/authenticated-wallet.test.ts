import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  wallets: [] as Array<Record<string, any>>,
  getWallets: vi.fn()
}));

vi.mock("@wallet-standard/app", () => ({
  getWallets: mocks.getWallets
}));

import { SolanaSignAndSendTransaction } from "@solana/wallet-standard-features";
import { findAuthenticatedWallet } from "./authenticated-wallet";

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
