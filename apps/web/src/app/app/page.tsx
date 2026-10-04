import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
  CreateWorkspaceForm
} from "../../components/auth/CreateWorkspaceForm";
import {
  SignOutButton
} from "../../components/auth/SignOutButton";
import {
  WORKSPACE_ROLE_LABELS
} from "../../server/authorization";
import { getDatabase } from "../../server/db";
import {
  getSessionState
} from "../../server/session";
import {
  listWorkspaceMemberships
} from "@paylore/database";

export const metadata: Metadata = {
  title: "Workspace access",
  robots: {
    index: false,
    follow: false
  }
};

export default async function AppGatewayPage() {
  const sessionState =
    await getSessionState();

  if (
    sessionState.status ===
    "unauthenticated"
  ) {
    redirect(
      "/auth?next=%2Fapp"
    );
  }

  if (
    sessionState.status ===
    "inactivity_expired"
  ) {
    redirect(
      "/auth?reason=inactivity-expired&next=%2Fapp"
    );
  }

  if (
    sessionState.status ===
    "hard_expired"
  ) {
    redirect(
      "/auth?reason=hard-expired&next=%2Fapp"
    );
  }

  const memberships =
    await listWorkspaceMemberships(
      getDatabase(),
      sessionState.session.userId
    );

  if (memberships.length === 1) {
    redirect(
      `/workspace/${memberships[0].workspaceId}`
    );
  }

  return (
    <div className="protected-wrap">
      <header className="protected-header">
        <p className="eyebrow">
          Workspace access
        </p>

        <h1>
          {memberships.length === 0
            ? "Create your Paylore workspace"
            : "Choose a workspace"}
        </h1>

        <p>
          Signed in as{" "}
          <strong>
            {sessionState.session.walletAddress}
          </strong>
          .
        </p>
      </header>

      {memberships.length === 0 ? (
        <>
          <div className="invite-state">
            <h2>
              You do not have a workspace
              membership yet.
            </h2>

            <p>
              Creating a workspace makes the
              authenticated creator its Organization
              Administrator.
            </p>

            <CreateWorkspaceForm />
          </div>
        </>
      ) : (
        <section
          className="workspace-grid"
          aria-label="Your workspaces"
        >
          {memberships.map(
            (membership) => (
              <article
                className="workspace-card"
                key={membership.workspaceId}
              >
                <h2>
                  {membership.workspaceName}
                </h2>

                <span className="workspace-card__role">
                  {
                    WORKSPACE_ROLE_LABELS[
                      membership.role
                    ]
                  }
                </span>

                <p className="workspace-card__meta">
                  Workspace ID:{" "}
                  {membership.workspaceId}
                </p>

                <div className="protected-actions">
                  <a
                    className="button"
                    href={`/workspace/${membership.workspaceId}`}
                  >
                    Enter workspace
                  </a>
                </div>
              </article>
            )
          )}
        </section>
      )}

      <div className="protected-actions">
        <SignOutButton />
      </div>
    </div>
  );
}