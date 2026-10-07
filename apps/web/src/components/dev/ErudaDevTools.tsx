"use client";

import Script from "next/script";

declare global {
  interface Window {
    eruda?: {
      init: () => void;
    };
  }
}

export function ErudaDevTools() {
  if (
    process.env.NODE_ENV !== "development" ||
    process.env.NEXT_PUBLIC_ERUDA !== "true"
  ) {
    return null;
  }

  return (
    <Script
      src="https://cdn.jsdelivr.net/npm/eruda"
      strategy="afterInteractive"
      onLoad={() => {
        if (!window.eruda) {
          console.error("Eruda loaded without exposing its browser API.");
          return;
        }

        window.eruda.init();
      }}
      onError={() => {
        console.error("Failed to load Eruda from jsDelivr.");
      }}
    />
  );
}
