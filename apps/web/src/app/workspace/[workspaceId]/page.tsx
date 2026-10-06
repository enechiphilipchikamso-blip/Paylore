import type { Metadata } from "next";
import {
  notFound,
  redirect
} from "next/navigation";
import {
  SignOutButton
} from "../../../components/auth/SignOutButton";
import {
  WORKSPACE_ROLE_LABELS
} from "../../../server/authorization-policy";
import {
  getDatabase
} from "../../../server/db";
import {
  getSessionState
} from "../../../server/session";
import {
  getWorkspaceForUser
} from "@paylore/database";

export const metadata: Metadata = {
  title: "Workspace",
  robots: {
    index: false,
    follow: false
  }
};

export default async function WorkspacePage({
  params,
  searchParams
}: {
  params: Promise<{
    workspaceId: string;
  }>;
  searchParams: Promise<{
    created?: string;
  }>;
}) {
  const {
    workspaceId
  } = await params;

  const query =
    await searchParams;

  const sessionState =
    await getSessionState();

  if (
    sessionState.status ===
    "unauthenticated"
  ) {
    redirect(
      `/auth?next=${encodeURIComponent(
        `/workspace/${workspaceId}`
      )}`
    );
  }

  if (
    sessionState.status ===
    "inactivity_expired"
  ) {
    redirect(
      `/auth?reason=inactivity-expired&next=${encodeURIComponent(
        `/workspace/${workspaceId}`
      )}`
    );
  }

  if (
    sessionState.status ===
    "hard_expired"
  ) {
    redirect(
      `/auth?reason=hard-expired&next=${encodeURIComponent(
        `/workspace/${workspaceId}`
      )}`
    );
  }

  const workspace =
    await getWorkspaceForUser(
      getDatabase(),
      sessionState.session.userId,
      workspaceId
    );

  if (!workspace) {
    notFound();
  }

  return (
    <div className="protected-wrap">
      <header className="protected-header">
        <p className="eyebrow">
          Workspace
        </p>

        <h1>
          {workspace.workspaceName}
        </h1>

        <p>
          Your role:{" "}
          <strong>
            {
              WORKSPACE_ROLE_LABELS[
                workspace.role
              ]
            }
          </strong>
          .
        </p>
      </header>

      <section className="invite-state">
        {query.created === "1" ? (
          <div
            className="success-box"
            role="status"
          >
            Workspace created
          </div>
        ) : null}

        <h2>
          Workspace access is active
        </h2>

        <p>
          This workspace is available
          through your authenticated
          membership. Future workspace
          capabilities build on this
          authorization boundary.
        </p>

        <p className="workspace-card__meta">
          Workspace ID:{" "}
          {workspace.workspaceId}
        </p>

        <div className="protected-actions">
          <SignOutButton />
        </div>
      </section>
    </div>
  );
}