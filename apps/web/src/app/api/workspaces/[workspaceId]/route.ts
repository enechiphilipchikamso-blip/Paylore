import { NextResponse } from "next/server";
import {
  clearSessionCookie,
  getSessionState
} from "../../../../server/session";
import {
  assertSameOrigin
} from "../../../../server/security";
import {
  getDatabase
} from "../../../../server/db";
import {
  getWorkspaceForUser
} from "@paylore/database";

export const runtime = "nodejs";
export const dynamic =
  "force-dynamic";

export async function GET(
  request: Request,
  {
    params
  }: {
    params: Promise<{
      workspaceId: string;
    }>;
  }
) {
  const { workspaceId } =
    await params;

  const state =
    await getSessionState();

  if (
    state.status !==
    "authenticated"
  ) {
    await clearSessionCookie();

    return NextResponse.json(
      {
        error:
          "authentication_required"
      },
      { status: 401 }
    );
  }

  const membership =
    await getWorkspaceForUser(
      getDatabase(),
      state.session.userId,
      workspaceId
    );

  if (!membership) {
    return NextResponse.json(
      {
        error:
          "workspace_access_denied"
      },
      { status: 403 }
    );
  }

  return NextResponse.json({
    workspaceId:
      membership.workspaceId,
    workspaceName:
      membership.workspaceName,
    role:
      membership.role
  });
}