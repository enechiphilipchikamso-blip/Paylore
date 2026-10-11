import { timingSafeEqual } from "node:crypto";
import { NextResponse } from "next/server";
import { loadPayloreConfig } from "../../../../server/config";

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const MAX_EVENTS_PER_DELIVERY = 100;

class WebhookPayloadTooLargeError extends Error {}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function authorized(header: string | null, secret: string | undefined): boolean {
  if (!header || !secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`, "utf8");
  const provided = Buffer.from(header, "utf8");
  return (
    expected.length === provided.length &&
    timingSafeEqual(expected, provided)
  );
}

async function readBoundedBody(request: Request): Promise<string> {
  const reader = request.body?.getReader();
  if (!reader) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_WEBHOOK_BYTES) {
        await reader.cancel();
        throw new WebhookPayloadTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = Buffer.concat(chunks);
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

export async function POST(request: Request) {
  const secret = loadPayloreConfig().PAYLORE_HELIUS_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "webhook_not_configured" },
      { status: 503 }
    );
  }
  if (!authorized(request.headers.get("authorization"), secret)) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }

  let payload: unknown;
  try {
    const rawBody = await readBoundedBody(request);
    payload = JSON.parse(rawBody) as unknown;
  } catch (error) {
    if (error instanceof WebhookPayloadTooLargeError) {
      return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    }
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  if (
    !Array.isArray(payload) ||
    payload.length === 0 ||
    payload.length > MAX_EVENTS_PER_DELIVERY ||
    payload.some((event) => !event || typeof event !== "object" || Array.isArray(event))
  ) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  return NextResponse.json(
    { status: "accepted", events: payload.length },
    { status: 202, headers: { "Cache-Control": "no-store" } }
  );
}
