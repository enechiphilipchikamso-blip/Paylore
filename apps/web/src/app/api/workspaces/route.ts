import { NextResponse } from "next/server";
import { z } from "zod";
import {
  clearSessionCookie,
  getSessionState
} from "../../../server/session";
import {
  assertSameOrigin
} from "../../../server/security";
import { getDatabase } from "../../../server/db";
import {
  createWorkspaceForUser,
  WorkspaceCreationRateLimitError
} from "../../../server/workspaces";

const createWorkspaceSchema =
  z.object({
    name: z
      .string()
      .trim()
      .min(1)
      .max(120)
  });

export const runtime = "nodejs";
export const dynamic =
  "force-dynamic";

export async function POST(
  request: Request
) {
  try {
    assertSameOrigin(request);

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

    const body =
      await request.json();

    const parsed =
      createWorkspaceSchema.safeParse(
        body
      );

    if (!parsed.success) {
      return NextResponse.json(
        {
          error:
            "invalid_workspace_name"
        },
        { status: 400 }
      );
    }

    const workspace =
      await createWorkspaceForUser(
        getDatabase(),
        {
          userId:
            state.session.userId,
          name:
            parsed.data.name
        }
      );

    return NextResponse.json(
      workspace,
      { status: 201 }
    );
  } catch (error) {
    if (
      error instanceof
      WorkspaceCreationRateLimitError
    ) {
      return NextResponse.json(
        {
          error:
            "workspace_creation_rate_limited"
        },
        {
          status: 429,
          headers: {
            "Retry-After":
              String(
                error.retryAfterSeconds
              )
          }
        }
      );
    }

    return NextResponse.json(
      {
        error:
          "workspace_creation_failed"
      },
      { status: 500 }
    );
  }
}