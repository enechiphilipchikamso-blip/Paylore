import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@paylore/database"],
  serverExternalPackages: ["@solana/zk-sdk"]
};

export default nextConfig;