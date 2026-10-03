import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { PublicShell } from "../components/public/PublicShell";
import { metadataBase, siteConfig } from "./site";
import "./globals.css";

const themeBootstrapScript = `
(function () {
  try {
    var stored = localStorage.getItem("paylore-theme");
    if (stored === "light" || stored === "dark") {
      document.documentElement.setAttribute("data-theme", stored);
    }
  } catch (_) {}
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
    icon: "/icons/favicon.svg",
    apple: "/icons/favicon-180x180.png"
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
      </body>
    </html>
  );
}