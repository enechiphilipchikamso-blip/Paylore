import type { Metadata } from "next";
import Link from "next/link";
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
  getWorkspaceForUser,
  listWorkspaceMemberships
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

  const db = getDatabase();
  const [workspace, memberships] =
    await Promise.all([
      getWorkspaceForUser(
        db,
        sessionState.session.userId,
        workspaceId
      ),
      listWorkspaceMemberships(
        db,
        sessionState.session.userId
      )
    ]);

  if (!workspace) {
    notFound();
  }

  return (
    <div className="protected-wrap">
      <nav
        className="workspace-navigation"
        aria-label="Workspace navigation"
      >
        <Link
          className="workspace-navigation__all"
          href="/app"
        >
          All workspaces
        </Link>

        <details className="workspace-switcher">
          <summary>
            <span>Current workspace</span>
            <strong>
              {workspace.workspaceName}
            </strong>
          </summary>

          <div className="workspace-switcher__menu">
            <p>Switch workspace</p>
            {memberships.map(
              (membership) => (
                <Link
                  className="workspace-switcher__option"
                  href={`/workspace/${membership.workspaceId}`}
                  key={membership.workspaceId}
                  aria-current={
                    membership.workspaceId === workspace.workspaceId
                      ? "page"
                      : undefined
                  }
                >
                  <span>
                    {membership.workspaceName}
                  </span>
                  <small>
                    {
                      WORKSPACE_ROLE_LABELS[
                        membership.role
                      ]
                    }
                  </small>
                </Link>
              )
            )}
            <Link
              className="workspace-switcher__create"
              href="/app#create-workspace"
            >
              Create workspace
            </Link>
          </div>
        </details>
      </nav>

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