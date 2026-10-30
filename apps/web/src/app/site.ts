import type { Metadata } from "next";
import { APP_IDENTITY } from "./app-identity";

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

const productionFallback =
  process.env.NODE_ENV === "production"
    ? new URL(APP_IDENTITY.productionOrigin)
    : undefined;

export const siteOrigin =
  configuredSiteOrigin?.origin ??
  productionFallback?.origin ??
  LOCAL_DEVELOPMENT_ORIGIN;

export const metadataBase = new URL(siteOrigin);

const canonicalSiteOrigin =
  configuredSiteOrigin ?? productionFallback;

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
  name: APP_IDENTITY.name,
  shortName: APP_IDENTITY.shortName,
  description: APP_IDENTITY.description,
  socialDescription: APP_IDENTITY.socialDescription,
  logo: "/brand/paylore.svg",
  icon: APP_IDENTITY.icons.png512,
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
  const canonicalUrl = canonicalSiteOrigin
    ? new URL(path, canonicalSiteOrigin).toString()
    : undefined;

  return {
    title,
    description,
    ...(canonicalUrl
      ? {
          alternates: {
            canonical: canonicalUrl
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
