import type { Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { ErudaDevTools } from "../components/dev/ErudaDevTools";
import { PublicShell } from "../components/public/PublicShell";
import { APP_IDENTITY, createRootMetadata } from "./app-identity";
import { metadataBase } from "./site";
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

export const metadata = createRootMetadata(metadataBase);

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
        <link
          rel="apple-touch-icon"
          sizes="180x180"
          type="image/png"
          href={APP_IDENTITY.icons.appleTouch}
        />
        <link
          rel="shortcut icon"
          type="image/x-icon"
          href={APP_IDENTITY.icons.faviconIco}
        />
        <link
          rel="icon"
          sizes="32x32"
          type="image/x-icon"
          href={APP_IDENTITY.icons.faviconIco}
        />
        <link
          rel="icon"
          sizes="192x192"
          type="image/png"
          href={APP_IDENTITY.icons.png192}
        />
        <link
          rel="icon"
          type="image/svg+xml"
          href={APP_IDENTITY.icons.faviconSvg}
        />
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
