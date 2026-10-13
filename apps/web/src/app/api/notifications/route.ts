import { NextResponse } from "next/server";
import { z } from "zod";
import {
  listUserNotifications,
  markAllUserNotificationsRead,
  markUserNotificationRead
} from "@paylore/database";
import { clearSessionCookie, getSessionState } from "../../../server/session";
import { assertSameOrigin, RequestSecurityError } from "../../../server/security";
import { getDatabase } from "../../../server/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const session = await getSessionState();
  if (session.status !== "authenticated") {
    await clearSessionCookie();
    return NextResponse.json(
      { error: "authentication_required" },
      { status: 401 }
    );
  }
  const notifications = await listUserNotifications(
    getDatabase(),
    session.session.userId
  );
  return NextResponse.json(
    { notifications },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
    const session = await getSessionState();
    if (session.status !== "authenticated") {
      await clearSessionCookie();
      return NextResponse.json(
        { error: "authentication_required" },
        { status: 401 }
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

    const db = getDatabase();
    if (parsed.data.action === "mark_all_read") {
      const updated = await markAllUserNotificationsRead(db, {
        recipientKey: session.session.userId
      });
      return NextResponse.json(
        { status: "read", updated },
        { headers: { "Cache-Control": "no-store" } }
      );
    }
    const updated = await markUserNotificationRead(db, {
      recipientKey: session.session.userId,
      notificationId: parsed.data.notificationId
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
