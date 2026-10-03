import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ImageResponse } from "next/og";

export const socialImageSize = {
  width: 1200,
  height: 630
};

export async function createSocialImage() {
  const logoData = await readFile(
    join(process.cwd(), "public/brand/paylore.png"),
    "base64"
  );

  const logoSrc = `data:image/png;base64,${logoData}`;

  return new ImageResponse(
    (
      <div
        style={{
          display: "flex",
          width: "100%",
          height: "100%",
          padding: "64px",
          background: "#08111d",
          color: "#f1f6fb"
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            justifyContent: "space-between",
            width: "100%"
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "24px"
            }}
          >
            <div
              style={{
                display: "flex",
                width: "96px",
                height: "96px",
                padding: "12px",
                borderRadius: "24px",
                background: "#ffffff"
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- ImageResponse supports nested images for generated OG images. */}
              <img
                src={logoSrc}
                width={72}
                height={72}
                alt=""
              />
            </div>

            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: "6px"
              }}
            >
              <div
                style={{
                  fontSize: "30px",
                  fontWeight: 700
                }}
              >
                Paylore
              </div>

              <div
                style={{
                  fontSize: "20px",
                  color: "#a6b5c6"
                }}
              >
                Private on-chain payroll
              </div>
            </div>
          </div>

          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "22px"
            }}
          >
            <div
              style={{
                maxWidth: "980px",
                fontSize: "60px",
                lineHeight: 1.05,
                fontWeight: 700,
                letterSpacing: "-0.035em"
              }}
            >
              Private compensation for on-chain organizations.
            </div>

            <div
              style={{
                maxWidth: "900px",
                fontSize: "28px",
                lineHeight: 1.25,
                color: "#a6b5c6"
              }}
            >
              USDC payroll on Solana with confidential compensation
              and defined ownership boundaries.
            </div>
          </div>

          <div
            style={{
              display: "flex",
              fontSize: "20px",
              color: "#8d9eb1"
            }}
          >
            paylore
          </div>
        </div>
      </div>
    ),
    {
      ...socialImageSize
    }
  );
}