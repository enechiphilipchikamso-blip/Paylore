import { gunzipSync } from "node:zlib";
import { NextResponse } from "next/server";
import { persistSolanaWebhookEvents } from "@paylore/database";
import { loadPayloreConfig } from "../../../../server/config";
import { getDatabase } from "../../../../server/db";
import {
  normalizeQuickNodeWebhookPayload,
  verifyQuickNodeWebhookHmac
} from "../../../../server/solana/webhook-policy";

const MAX_WEBHOOK_BYTES = 1024 * 1024;
const MAX_EVENTS_PER_DELIVERY = 100;

class WebhookPayloadTooLargeError extends Error {}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function readBoundedBody(request: Request): Promise<Buffer> {
  const reader = request.body?.getReader();
  if (!reader) return Buffer.alloc(0);
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

  return Buffer.concat(chunks);
}

function decodePayload(request: Request, body: Buffer): string {
  const contentEncoding = request.headers.get("content-encoding");
  if (
    contentEncoding &&
    contentEncoding.toLowerCase() !== "identity" &&
    contentEncoding.toLowerCase() !== "gzip"
  ) {
    throw new Error("unsupported_content_encoding");
  }

  const compressed =
    contentEncoding?.toLowerCase() === "gzip" &&
    body.length >= 2 &&
    body[0] === 0x1f &&
    body[1] === 0x8b;
  let payload: Buffer;
  try {
    payload = compressed
      ? gunzipSync(body, { maxOutputLength: MAX_WEBHOOK_BYTES })
      : body;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      error.code === "ERR_BUFFER_TOO_LARGE"
    ) {
      throw new WebhookPayloadTooLargeError();
    }
    throw error;
  }
  if (payload.length > MAX_WEBHOOK_BYTES) {
    throw new WebhookPayloadTooLargeError();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(payload);
}

export async function POST(request: Request) {
  const secret = loadPayloreConfig().PAYLORE_QUICKNODE_WEBHOOK_SECRET;
  if (!secret) {
    return NextResponse.json(
      { error: "webhook_not_configured" },
      { status: 503 }
    );
  }

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_WEBHOOK_BYTES) {
    return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
  }

  let rawPayload: string;
  try {
    rawPayload = decodePayload(request, await readBoundedBody(request));
  } catch (error) {
    if (error instanceof WebhookPayloadTooLargeError) {
      return NextResponse.json({ error: "payload_too_large" }, { status: 413 });
    }
    if (
      error instanceof Error &&
      error.message === "unsupported_content_encoding"
    ) {
      return NextResponse.json(
        { error: "unsupported_content_encoding" },
        { status: 415 }
      );
    }
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const nonce = request.headers.get("x-qn-nonce");
  const timestamp = request.headers.get("x-qn-timestamp");
  const signature = request.headers.get("x-qn-signature");
  if (
    !nonce ||
    nonce.length > 256 ||
    !timestamp ||
    timestamp.length > 64 ||
    !signature ||
    !verifyQuickNodeWebhookHmac({
      secret,
      nonce,
      timestamp,
      payload: rawPayload,
      signature
    })
  ) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawPayload) as unknown;
  } catch {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  const events = normalizeQuickNodeWebhookPayload(payload);
  if (!events || events.length > MAX_EVENTS_PER_DELIVERY) {
    return NextResponse.json({ error: "invalid_payload" }, { status: 400 });
  }

  try {
    const stored = await persistSolanaWebhookEvents(
      getDatabase(),
      events.map((event) => ({
        ...event,
        status: "received"
      }))
    );
    return NextResponse.json(
      {
        status: "received",
        events: events.length,
        inserted: stored.inserted,
        duplicates: stored.duplicates
      },
      { status: 202, headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    console.error(JSON.stringify({ event: "quicknode_webhook_persistence_failed" }));
    return NextResponse.json(
      { error: "webhook_event_not_persisted" },
      { status: 503 }
    );
  }
}
