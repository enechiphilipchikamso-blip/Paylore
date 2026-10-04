"use client";

import type { ReactNode } from "react";
import { UnifiedWalletProvider } from "@jup-ag/wallet-adapter";

export function WalletProvider({
  children
}: {
  children: ReactNode;
}) {
  const origin =
    typeof window === "undefined"
      ? "http://localhost:3100"
      : window.location.origin;

  return (
    <UnifiedWalletProvider
      wallets={[]}
      config={{
        env: "devnet",
        autoConnect: false,
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
      }}
    >
      {children}
    </UnifiedWalletProvider>
  );
}