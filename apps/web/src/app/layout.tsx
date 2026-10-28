import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { ErudaDevTools } from "../components/dev/ErudaDevTools";
import { PublicShell } from "../components/public/PublicShell";
import { metadataBase, siteConfig } from "./site";
import "./globals.css";

const geistSans = Geist({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-geist-sans"
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-geist-mono"
});

const themeBootstrapScript = `
(function () {
  var stored = null;
  try { stored = localStorage.getItem("paylore-theme"); } catch (_) {}
  if (stored !== "light" && stored !== "dark" && stored !== "system") {
    var match = document.cookie.match(/(?:^|;\\s*)paylore-theme=(system|light|dark)(?:;|$)/);
    stored = match ? match[1] : null;
  }
  if (stored === "light" || stored === "dark") {
    document.documentElement.setAttribute("data-theme", stored);
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
})();
`;

export const viewport: Viewport = {
  colorScheme: "light dark",
  themeColor: [
    {
      media: "(prefers-color-scheme: light)",
      color: "#f7f9fc"
    },
    {
      media: "(prefers-color-scheme: dark)",
      color: "#08111d"
    }
  ]
};

export const metadata: Metadata = {
  metadataBase,
  manifest: "/manifest.webmanifest",
  title: {
    default: "Paylore | Private on-chain payroll",
    template: "%s | Paylore"
  },
  description: siteConfig.description,
  applicationName: siteConfig.name,
  keywords: [
    "Paylore",
    "private payroll",
    "on-chain payroll",
    "USDC payroll",
    "Solana payroll"
  ],
  icons: {
    icon: [
      { url: "/icons/paylore-192x192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/paylore-512x512.png", sizes: "512x512", type: "image/png" },
      { url: "/favicon.svg", type: "image/svg+xml" },
      { url: "/icons/favicon.svg", type: "image/svg+xml" }
    ],
    shortcut: [
      { url: "/icons/paylore-192x192.png", sizes: "192x192", type: "image/png" }
    ],
    apple: [
      { url: "/icons/paylore-180x180.png", sizes: "180x180", type: "image/png" }
    ]
  },
  appleWebApp: {
    capable: true,
    title: "Paylore",
    statusBarStyle: "default"
  },
  openGraph: {
    type: "website",
    siteName: siteConfig.name,
    title: "Paylore | Private on-chain payroll",
    description: siteConfig.socialDescription,
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
    title: "Paylore | Private on-chain payroll",
    description: siteConfig.socialDescription,
    images: [siteConfig.twitterImage]
  }
};

export default function RootLayout({
  children
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html
      lang="en"
      data-scroll-behavior="smooth"
      className={`${geistSans.variable} ${geistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script
          dangerouslySetInnerHTML={{
            __html: themeBootstrapScript
          }}
        />
      </head>
      <body>
        <PublicShell>{children}</PublicShell>
        <ErudaDevTools />
      </body>
    </html>
  );
}