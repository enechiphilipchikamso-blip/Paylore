import {
  createSocialImage,
  socialImageSize
} from "./og-image";

export const runtime = "nodejs";

export const alt =
  "Paylore — Private on-chain payroll";

export const size = socialImageSize;

export const contentType = "image/png";

export default async function Image() {
  return createSocialImage();
}