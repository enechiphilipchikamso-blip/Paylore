import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Paylore",
    short_name: "Paylore",
    description: "Private on-chain payroll for crypto-native organizations.",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f7f9fc",
    theme_color: "#16355f",
    icons: [
      {
        src: "/icons/paylore-192x192.png",
        sizes: "192x192",
        type: "image/png",
      },
      {
        src: "/icons/paylore-512x512.png",
        sizes: "512x512",
        type: "image/png",
      },
      {
        src: "/icons/paylore-180x180.png",
        sizes: "512x512",
        type: "image/png",
      },
      {
        src: "/brand/paylore.png",
        sizes: "192x192",
        type: "image/png",
        purpose: "maskable",
      },
      {
        src: "/brand/paylore.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
    ],
  };
}