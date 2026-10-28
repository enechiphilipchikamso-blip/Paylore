import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getWorkspaceForUser,
  listWorkspaceDeadLetterSolanaWebhookEvents,
  retryDeadLetterSolanaWebhookEvent
} from "@paylore/database";
import { clearSessionCookie, getSessionState } from "../../../../../server/session";
import { getDatabase } from "../../../../../server/db";
import { assertSameOrigin, RequestSecurityError } from "../../../../../server/security";

type RouteContext = { params: Promise<{ workspaceId: string }> };
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function authorize(workspaceId: string) {
  const session = await getSessionState();
  if (session.status !== "authenticated") {
    await clearSessionCookie();
    return { response: NextResponse.json({ error: "authentication_required" }, { status: 401 }) } as const;
  }
  const db = getDatabase();
  const workspace = await getWorkspaceForUser(db, session.session.userId, workspaceId);
  if (!workspace || workspace.role !== "organization_admin") {
    return { response: NextResponse.json({ error: "workspace_access_denied" }, { status: 403 }) } as const;
  }
  return { db } as const;
}

export async function GET(_request: Request, { params }: RouteContext): Promise<Response> {
  const { workspaceId } = await params;
  const access = await authorize(workspaceId);
  if ("response" in access) return access.response!;
  try {
    const events = await listWorkspaceDeadLetterSolanaWebhookEvents(access.db, { workspaceId, limit: 100 });
    return NextResponse.json({ events }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ error: "webhook_events_unavailable" }, { status: 503 });
  }
}

export async function POST(request: Request, { params }: RouteContext): Promise<Response> {
  try {
    assertSameOrigin(request);
    const { workspaceId } = await params;
    const access = await authorize(workspaceId);
    if ("response" in access) return access.response!;
    if (Number(request.headers.get("content-length") ?? 0) > 2048) {
      return NextResponse.json({ error: "request_too_large" }, { status: 413 });
    }
    const raw = await request.text();
    if (raw.length > 2048) return NextResponse.json({ error: "request_too_large" }, { status: 413 });
    let body: unknown;
    try { body = JSON.parse(raw); } catch {
      return NextResponse.json({ error: "invalid_retry_request" }, { status: 400 });
    }
    const parsed = z.object({ eventId: z.string().uuid() }).strict().safeParse(body);
    if (!parsed.success) return NextResponse.json({ error: "invalid_retry_request" }, { status: 400 });
    const retried = await retryDeadLetterSolanaWebhookEvent(access.db, {
      workspaceId,
      eventId: parsed.data.eventId
    });
    if (!retried) return NextResponse.json({ error: "dead_letter_not_found" }, { status: 404 });
    return NextResponse.json({ status: "retry_scheduled" }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return NextResponse.json({ error: "request_not_allowed" }, { status: 403 });
    }
    return NextResponse.json({ error: "webhook_retry_failed" }, { status: 503 });
  }
}
