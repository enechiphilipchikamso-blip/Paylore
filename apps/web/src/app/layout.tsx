import type { Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import type { ReactNode } from "react";
import { ErudaDevTools } from "../components/dev/ErudaDevTools";
import { PublicShell } from "../components/public/PublicShell";
import { createRootMetadata } from "./app-identity";
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
