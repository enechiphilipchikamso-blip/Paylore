import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@paylore/database"],
  serverExternalPackages: ["@solana/zk-sdk"],
  env: {
    // Public network name only; it selects the wallet chain and explorer cluster in the browser.
    NEXT_PUBLIC_PAYLORE_NETWORK:
      process.env.PAYLORE_NETWORK ?? process.env.SOLANA_NETWORK ?? "devnet"
  }
};

export default nextConfig;
