"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

export function SignOutButton() {
  const router = useRouter();

  const [busy, setBusy] =
    useState(false);

  async function signOut() {
    setBusy(true);

    try {
      await fetch(
        "/api/auth/logout",
        {
          method: "POST",
          credentials: "same-origin"
        }
      );
    } finally {
      router.replace(
        "/auth?reason=logged-out"
      );
      router.refresh();
    }
  }

  return (
    <button
      className="button button--secondary"
      type="button"
      onClick={() => void signOut()}
      disabled={busy}
    >
      {busy
        ? "Signing out…"
        : "Sign out"}
    </button>
  );
}