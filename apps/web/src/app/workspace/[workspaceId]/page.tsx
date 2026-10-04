import type { Metadata } from "next";
import { notFound, redirect } from "next/navigation";
import {
  SignOutButton
} from "../../../components/auth/SignOutButton";
import {
  WORKSPACE_ROLE_LABELS
} from "../../../server/authorization";
import { getDatabase } from "../../../server/db";
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
  params
}: {
  params: Promise<{
    workspaceId: string;
  }>;
}) {
  const { workspaceId } =
    await params;

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
        <h2>
          Workspace access is active
        </h2>

        <p>
          This authenticated workspace boundary
          is intentionally established before
          billing, contributor management, or
          payroll functionality.
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