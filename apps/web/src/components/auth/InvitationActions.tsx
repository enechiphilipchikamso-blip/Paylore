"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";

export function InvitationActions({
  authPath
}: {
  authPath: string;
}) {
  const router = useRouter();
  const { disconnect } =
    useWallet();

  const [busy, setBusy] =
    useState(false);

  async function switchWallet() {
    setBusy(true);

    try {
      await disconnect();
    } finally {
      router.push(authPath);
    }
  }

  return (
    <div className="hero__actions">
      <button
        className="button"
        type="button"
        onClick={() =>
          void switchWallet()
        }
        disabled={busy}
      >
        {busy
          ? "Disconnecting…"
          : "Disconnect and retry"}
      </button>

      <button
        className="button button--secondary"
        type="button"
        onClick={() =>
          router.push(authPath)
        }
      >
        Switch wallet
      </button>
    </div>
  );
}