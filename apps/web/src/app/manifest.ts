import type { MetadataRoute } from "next";
import { APP_IDENTITY } from "./app-identity";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: APP_IDENTITY.name,
    short_name: APP_IDENTITY.shortName,
    id: "/",
    description: APP_IDENTITY.description,
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#f7f9fc",
    theme_color: "#16355f",
    icons: [
      {
        src: APP_IDENTITY.icons.png192,
        sizes: "192x192",
        type: "image/png",
        purpose: "any"
      },
      {
        src: APP_IDENTITY.icons.png512,
        sizes: "512x512",
        type: "image/png",
        purpose: "any"
      },
      {
        src: APP_IDENTITY.icons.appleTouch,
        sizes: "180x180",
        type: "image/png",
        purpose: "any"
      },
      {
        src: "/brand/paylore.png",
        sizes: "1254x1254",
        type: "image/png",
        purpose: "maskable"
      },
      {
        src: "/brand/paylore.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any"
      }
    ]
  };
}
