import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { APP_IDENTITY, createRootMetadata } from "./app-identity";
import manifest from "./manifest";
import { createPublicMetadata, metadataBase, siteConfig } from "./site";

const pngSignature = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]);

async function readPublicAsset(path: string): Promise<Buffer> {
  const relativePath = path.startsWith("/") ? path.slice(1) : path;
  return readFile(
    new URL("../../public/" + relativePath, import.meta.url)
  );
}

function expectPngDimensions(
  image: Buffer,
  width: number,
  height: number
): void {
  expect(image.subarray(0, 8)).toEqual(pngSignature);
  expect(image.readUInt32BE(16)).toBe(width);
  expect(image.readUInt32BE(20)).toBe(height);
}

describe("Paylore public dApp identity", () => {
  it("publishes one canonical name, URL, favicon, and Apple touch icon", () => {
    const metadata = createRootMetadata(metadataBase);
    const icons = metadata.icons as {
      icon: Array<{ url: string; type?: string; sizes?: string }>;
      shortcut: Array<{ url: string; type?: string }>;
      apple: Array<{ url: string; type?: string; sizes?: string }>;
    };

    expect(metadata.applicationName).toBe(APP_IDENTITY.name);
    expect(metadata.metadataBase).toEqual(metadataBase);
    expect(metadata.manifest).toBe(APP_IDENTITY.manifestPath);
    expect(metadata.title).toEqual({
      default: "Paylore | Private on-chain payroll",
      template: "%s | Paylore"
    });
    expect(metadata.openGraph).toMatchObject({
      siteName: APP_IDENTITY.name,
      title: "Paylore | Private on-chain payroll"
    });
    expect(icons.icon).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          url: APP_IDENTITY.icons.faviconIco,
          type: "image/x-icon"
        }),
        expect.objectContaining({
          url: APP_IDENTITY.icons.png192,
          sizes: "192x192",
          type: "image/png"
        }),
        expect.objectContaining({
          url: APP_IDENTITY.icons.png512,
          sizes: "512x512",
          type: "image/png"
        })
      ])
    );
    expect(icons.shortcut).toContainEqual(
      expect.objectContaining({ url: APP_IDENTITY.icons.faviconIco })
    );
    expect(icons.apple).toContainEqual(
      expect.objectContaining({
        url: APP_IDENTITY.icons.appleTouch,
        sizes: "180x180",
        type: "image/png"
      })
    );
    expect(siteConfig.icon).toBe(APP_IDENTITY.icons.png512);
  });

  it("keeps page metadata canonical and absolute on the selected site origin", () => {
    const metadata = createPublicMetadata({
      title: "Pricing",
      description: "Paylore workspace pricing.",
      path: "/pricing"
    });
    const canonicalUrl = new URL(String(metadata.alternates?.canonical));
    const openGraphUrl = new URL(
      String((metadata.openGraph as { url?: string | URL }).url)
    );

    expect(canonicalUrl.pathname).toBe("/pricing");
    expect(canonicalUrl.origin).toBe(metadataBase.origin);
    expect(openGraphUrl.origin).toBe(metadataBase.origin);
  });

  it("serves real PNG assets with their declared square dimensions", async () => {
    const assets = [
      { path: APP_IDENTITY.icons.appleTouch, width: 180, height: 180 },
      { path: APP_IDENTITY.icons.png180, width: 180, height: 180 },
      { path: APP_IDENTITY.icons.png192, width: 192, height: 192 },
      { path: APP_IDENTITY.icons.png512, width: 512, height: 512 }
    ];

    for (const asset of assets) {
      const image = await readPublicAsset(asset.path);
      expectPngDimensions(image, asset.width, asset.height);
    }
  });

  it("serves a real ICO favicon and an SVG fallback from public paths", async () => {
    const ico = await readPublicAsset(APP_IDENTITY.icons.faviconIco);
    expect(ico.readUInt16LE(0)).toBe(0);
    expect(ico.readUInt16LE(2)).toBe(1);
    expect(ico.readUInt16LE(4)).toBeGreaterThan(0);

    const svg = await readPublicAsset(APP_IDENTITY.icons.faviconSvg);
    expect(svg.toString("utf8")).toContain("<svg");
    expect(svg.toString("utf8")).toContain('xmlns="http://www.w3.org/2000/svg"');
  });

  it("keeps the install manifest name, formats, dimensions, and public asset paths aligned", () => {
    const appManifest = manifest();
    expect(appManifest.name).toBe(APP_IDENTITY.name);
    expect(appManifest.short_name).toBe(APP_IDENTITY.shortName);

    for (const expected of [
      { src: APP_IDENTITY.icons.png192, sizes: "192x192", type: "image/png" },
      { src: APP_IDENTITY.icons.png512, sizes: "512x512", type: "image/png" },
      { src: APP_IDENTITY.icons.appleTouch, sizes: "180x180", type: "image/png" }
    ]) {
      expect(appManifest.icons).toContainEqual(
        expect.objectContaining(expected)
      );
    }
  });

  it("sets revalidating public cache headers without requiring authentication", async () => {
    const netlifyConfig = await readFile(
      new URL("../../../../netlify.toml", import.meta.url),
      "utf8"
    );
    const headerSections = netlifyConfig
      .split("[[headers]]")
      .slice(1)
      .map((content) => {
        const pathLine = content
          .split("\n")
          .find((line) => line.trim().startsWith("for = "));
        return {
          path: pathLine?.split('"')[1],
          content
        };
      });

    const expectedPaths = [
      APP_IDENTITY.icons.faviconIco,
      APP_IDENTITY.icons.faviconSvg,
      APP_IDENTITY.icons.appleTouch,
      "/icons/*",
      APP_IDENTITY.manifestPath
    ];

    for (const path of expectedPaths) {
      const section = headerSections.find((match) => match.path === path);
      expect(section, "Missing public header rule for " + path).toBeTruthy();
      expect(section?.content).toContain(
        'Cache-Control = "public, max-age=0, must-revalidate"'
      );
      expect(section?.content).toContain('X-Content-Type-Options = "nosniff"');
    }
  });
});
