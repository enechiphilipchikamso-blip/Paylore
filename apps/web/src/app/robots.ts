import type { MetadataRoute } from "next";
import { siteOrigin } from "./site";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [
        "/api/",
        "/app/",
        "/dashboard/",
        "/workspace/"
      ]
    },
    sitemap: `${siteOrigin}/sitemap.xml`
  };
}