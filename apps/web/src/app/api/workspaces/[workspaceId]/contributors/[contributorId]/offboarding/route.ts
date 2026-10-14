import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getWorkspaceForUser,
  requestContributorOffboarding
} from "@paylore/database";
import { clearSessionCookie, getSessionState } from "../../../../../../../server/session";
import { getDatabase } from "../../../../../../../server/db";
import { assertSameOrigin, RequestSecurityError } from "../../../../../../../server/security";

const requestSchema = z.object({
  confirmation: z.literal("Request contributor review")
});

type RouteContext = {
  params: Promise<{ workspaceId: string; contributorId: string }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: RouteContext) {
  try {
    assertSameOrigin(request);
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
        { error: "invalid_offboarding_request" },
        { status: 400 }
      );
    }
    const { workspaceId, contributorId } = await params;
    const session = await getSessionState();
    if (session.status !== "authenticated") {
      await clearSessionCookie();
      return NextResponse.json(
        { error: "authentication_required" },
        { status: 401 }
      );
    }
    const db = getDatabase();
    const membership = await getWorkspaceForUser(
      db,
      session.session.userId,
      workspaceId
    );
    if (!membership || membership.role !== "organization_admin") {
      return NextResponse.json(
        { error: "workspace_access_denied" },
        { status: 403 }
      );
    }
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        { error: "offboarding_confirmation_required" },
        { status: 400 }
      );
    }

    const result = await requestContributorOffboarding(db, {
      workspaceId,
      contributorId
    });
    if (result.status === "not_found") {
      return NextResponse.json(
        { error: "contributor_not_found" },
        { status: 404 }
      );
    }
    if (result.status === "already_left") {
      return NextResponse.json(
        { error: "contributor_already_left" },
        { status: 409 }
      );
    }
    return NextResponse.json(
      {
        status: result.status,
        notificationCreated: result.notificationCreated
      },
      {
        status: result.status === "requested" ? 202 : 200,
        headers: { "Cache-Control": "no-store" }
      }
    );
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return NextResponse.json({ error: "request_not_allowed" }, { status: 403 });
    }
    console.error(JSON.stringify({ event: "offboarding_request_failed" }));
    return NextResponse.json(
      { error: "offboarding_request_failed" },
      { status: 503 }
    );
  }
}
