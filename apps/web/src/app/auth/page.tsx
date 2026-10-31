import type { Metadata } from "next";
import {
  PublicPage
} from "../../components/public/PublicPage";
import {
  WalletAuthPanel
} from "../../components/auth/WalletAuthPanel";
import {
  isSafeReturnTo
} from "../../server/security";
import { loadPayloreConfig } from "../../server/config";
import {
  getSolanaWalletDeepLinkCluster,
  isBackpackMobileDeepLinkEnabled
} from "../../server/auth/protocol";

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
    isSafeReturnTo(
      params.next
    );
  const config = loadPayloreConfig();
  const walletCluster = getSolanaWalletDeepLinkCluster(config.PAYLORE_NETWORK);

  const reason =
    params.reason ===
      "inactivity-expired" ||
    params.reason ===
      "hard-expired" ||
    params.reason === "logged-out"
      ? params.reason
      : undefined;

  return (
    <PublicPage
      eyebrow="WALLET AUTHENTICATION"
      title="Sign in to Paylore"
      description="Connect one of the supported Solana wallets and sign the Paylore authentication request. This signature proves wallet control; it does not send payroll funds or a payroll transaction."
    >
      <WalletAuthPanel
        nextPath={nextPath}
        reason={reason}
        walletCluster={walletCluster}
        backpackDeepLinkEnabled={isBackpackMobileDeepLinkEnabled(
          config.PAYLORE_NETWORK,
          config.PAYLORE_BACKPACK_MOBILE_DEEPLINK_ENABLED === "true"
        )}
      />
    </PublicPage>
  );
}