import type { Metadata } from "next";
import {
  PublicPage
} from "../../components/public/PublicPage";
import {
  WalletAuthPanel
} from "../../components/auth/WalletAuthPanel";
import {
  WalletProvider
} from "../../components/auth/WalletProvider";
import { isSafeReturnTo } from "../../server/security";

export const metadata: Metadata = {
  title: "Sign in",
  description:
    "Connect and authenticate with a supported Solana wallet to access Paylore.",
  robots: {
    index: false,
    follow: false
  }
};

export default async function AuthPage({
  searchParams
}: {
  searchParams: Promise<{
    next?: string;
    reason?: string;
  }>;
}) {
  const params =
    await searchParams;

  const nextPath =
    isSafeReturnTo(params.next);

  const reason =
    params.reason ===
      "inactivity-expired" ||
    params.reason ===
      "hard-expired" ||
    params.reason === "logged-out"
      ? params.reason
      : undefined;

  return (
    <WalletProvider>
      <PublicPage
        eyebrow="Secure entry"
        title="Wallet authentication"
        description="Connect a supported Solana wallet and explicitly sign a short-lived authentication challenge."
      >
        <WalletAuthPanel
          nextPath={nextPath}
          reason={reason}
        />
      </PublicPage>
    </WalletProvider>
  );
}