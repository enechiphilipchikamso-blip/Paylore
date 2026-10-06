"use client";

import {
  useMemo,
  type ReactNode
} from "react";
import {
  UnifiedWalletProvider
} from "@jup-ag/wallet-adapter";

export function WalletProvider({
  origin,
  children
}: {
  origin: string;
  children: ReactNode;
}) {
  const wallets = useMemo(
    () => [],
    []
  );

  const config = useMemo(
    () => ({
      autoConnect: false,
      env: "devnet" as const,
      metadata: {
        name: "Paylore",
        description:
          "Private on-chain payroll for crypto-native organizations.",
        url: origin,
        iconUrls: [
          new URL(
            "/icons/favicon.svg",
            origin
          ).toString()
        ]
      }
    }),
    [origin]
  );

  return (
    <UnifiedWalletProvider
      wallets={wallets}
      config={config}
    >
      {children}
    </UnifiedWalletProvider>
  );
}