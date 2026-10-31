import type { Metadata } from "next";

export const APP_IDENTITY = {
  name: "Paylore",
  shortName: "Paylore",
  description: "Private on-chain payroll for crypto-native organizations.",
  socialDescription:
    "Private on-chain payroll for crypto-native organizations using USDC on Solana.",
  productionOrigin: "https://paylore.netlify.app",
  manifestPath: "/manifest.webmanifest",
  icons: {
    faviconIco: "/favicon.ico",
    faviconSvg: "/favicon.svg",
    appleTouch: "/apple-touch-icon.png",
    png180: "/icons/paylore-180x180.png",
    png192: "/icons/paylore-192x192.png",
    png512: "/icons/paylore-512x512.png"
  }
} as const;

/**
 * Keeps the browser-visible identity consistent across the document head,
 * wallet metadata scrapers, and the installable web manifest.
 */
export function createRootMetadata(metadataBase: URL): Metadata {
  return {
    metadataBase,
    manifest: APP_IDENTITY.manifestPath,
    title: {
      default: "Paylore | Private on-chain payroll",
      template: "%s | Paylore"
    },
    description: APP_IDENTITY.description,
    applicationName: APP_IDENTITY.name,
    keywords: [
      "Paylore",
      "private payroll",
      "on-chain payroll",
      "USDC payroll",
      "Solana payroll"
    ],
    appleWebApp: {
      capable: true,
      title: APP_IDENTITY.shortName,
      statusBarStyle: "default"
    },
    openGraph: {
      type: "website",
      siteName: APP_IDENTITY.name,
      title: APP_IDENTITY.name,
      description: APP_IDENTITY.socialDescription,
      images: [
        {
          url: "/opengraph-image",
          width: 1200,
          height: 630,
          alt: "Paylore — Private on-chain payroll"
        }
      ]
    },
    twitter: {
      card: "summary_large_image",
      title: "Paylore | Private on-chain payroll",
      description: APP_IDENTITY.socialDescription,
      images: ["/twitter-image"]
    }
  };
}
