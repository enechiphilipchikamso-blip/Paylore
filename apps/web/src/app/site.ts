import type { Metadata } from "next";

const LOCAL_DEVELOPMENT_ORIGIN = "http://localhost:3000";

function parseOrigin(value: string | undefined): URL | undefined {
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }

    return new URL(url.origin);
  } catch {
    return undefined;
  }
}

const configuredSiteOrigin = [
  process.env.NEXT_PUBLIC_SITE_URL,
  process.env.DEPLOY_PRIME_URL,
  process.env.URL
]
  .map(parseOrigin)
  .find((value): value is URL => value !== undefined);

export const siteOrigin =
  configuredSiteOrigin?.origin ?? LOCAL_DEVELOPMENT_ORIGIN;

export const metadataBase = configuredSiteOrigin;

export const publicRoutes = [
  "/",
  "/product",
  "/pricing",
  "/docs",
  "/terms",
  "/privacy",
  "/security"
] as const;

export const siteConfig = {
  name: "Paylore",
  shortName: "Paylore",
  description:
    "Private on-chain payroll for crypto-native organizations.",
  socialDescription:
    "Private on-chain payroll for crypto-native organizations using USDC on Solana.",
  logo: "/brand/paylore.svg",
  ogImage: "/opengraph-image",
  twitterImage: "/twitter-image"
};

type PublicMetadataInput = {
  title: string;
  description: string;
  path: string;
};

export function createPublicMetadata({
  title,
  description,
  path
}: PublicMetadataInput): Metadata {
  const canonicalUrl = configuredSiteOrigin
    ? new URL(path, configuredSiteOrigin).toString()
    : undefined;

  return {
    title,
    description,
    ...(canonicalUrl
      ? {
          alternates: {
            canonical: path
          }
        }
      : {}),
    openGraph: {
      type: "website",
      siteName: siteConfig.name,
      title,
      description,
      ...(canonicalUrl ? { url: canonicalUrl } : {}),
      images: [
        {
          url: siteConfig.ogImage,
          width: 1200,
          height: 630,
          alt: "Paylore — Private on-chain payroll"
        }
      ]
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
      images: [siteConfig.twitterImage]
    }
  };
}