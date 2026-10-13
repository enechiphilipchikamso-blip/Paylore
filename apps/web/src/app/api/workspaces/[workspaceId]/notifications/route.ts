import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getWorkspaceForUser,
  listWorkspaceNotifications,
  markAllWorkspaceNotificationsRead,
  markWorkspaceNotificationRead
} from "@paylore/database";
import { clearSessionCookie, getSessionState } from "../../../../../server/session";
import { getDatabase } from "../../../../../server/db";
import { assertSameOrigin, RequestSecurityError } from "../../../../../server/security";
import { NOTIFICATION_CATEGORIES } from "../../../../../server/notification-policy";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: RouteContext) {
  const { workspaceId } = await params;
  const session = await getSessionState();
  if (session.status !== "authenticated") {
    await clearSessionCookie();
    return NextResponse.json(
      { error: "authentication_required" },
      { status: 401 }
    );
  }
  const db = getDatabase();
  const workspace = await getWorkspaceForUser(
    db,
    session.session.userId,
    workspaceId
  );
  if (!workspace) {
    return NextResponse.json(
      { error: "workspace_access_denied" },
      { status: 403 }
    );
  }
  const url = new URL(request.url);
  const unreadOnly = url.searchParams.get("unreadOnly");
  const category = url.searchParams.get("category");
  if (unreadOnly && unreadOnly !== "true" && unreadOnly !== "false") {
    return NextResponse.json(
      { error: "invalid_notification_filter" },
      { status: 400 }
    );
  }
  if (
    category &&
    !NOTIFICATION_CATEGORIES.some((value) => value === category)
  ) {
    return NextResponse.json(
      { error: "invalid_notification_filter" },
      { status: 400 }
    );
  }
  const notifications = await listWorkspaceNotifications(db, {
    workspaceId,
    recipientKey: session.session.userId,
    category: category ?? undefined,
    unreadOnly: unreadOnly === "true",
    limit: 100
  });
  return NextResponse.json(
    { notifications },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    assertSameOrigin(request);
    const { workspaceId } = await params;
    const session = await getSessionState();
    if (session.status !== "authenticated") {
      await clearSessionCookie();
      return NextResponse.json(
        { error: "authentication_required" },
        { status: 401 }
      );
    }
    const db = getDatabase();
    const workspace = await getWorkspaceForUser(
      db,
      session.session.userId,
      workspaceId
    );
    if (!workspace) {
      return NextResponse.json(
        { error: "workspace_access_denied" },
        { status: 403 }
      );
    }
    if (Number(request.headers.get("content-length") ?? 0) > 2048) {
      return NextResponse.json(
        { error: "request_too_large" },
        { status: 413 }
      );
    }
    const rawBody = await request.text();
    if (rawBody.length > 2048) {
      return NextResponse.json(
        { error: "request_too_large" },
        { status: 413 }
      );
    }
    let body: unknown;
    try {
      body = JSON.parse(rawBody);
    } catch {
      return NextResponse.json(
        { error: "invalid_notification_action" },
        { status: 400 }
      );
    }
    const parsed = z.discriminatedUnion("action", [
      z.object({
        action: z.literal("mark_read"),
        notificationId: z.string().uuid()
      }),
      z.object({ action: z.literal("mark_all_read") })
    ]).safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_notification_action" },
        { status: 400 }
      );
    }
    if (parsed.data.action === "mark_all_read") {
      const updated = await markAllWorkspaceNotificationsRead(db, {
        workspaceId,
        recipientKey: session.session.userId
      });
      return NextResponse.json(
        { status: "read", updated },
        { headers: { "Cache-Control": "no-store" } }
      );
    }
    const updated = await markWorkspaceNotificationRead(db, {
      workspaceId,
      notificationId: parsed.data.notificationId,
      recipientKey: session.session.userId
    });
    if (!updated) {
      return NextResponse.json(
        { error: "notification_not_found_or_already_read" },
        { status: 404 }
      );
    }
    return NextResponse.json(
      { status: "read", notificationId: updated.id },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return NextResponse.json({ error: "request_not_allowed" }, { status: 403 });
    }
    return NextResponse.json(
      { error: "notification_update_failed" },
      { status: 503 }
    );
  }
}
