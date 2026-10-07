import type { Metadata } from "next";
import Link from "next/link";
import { redirect } from "next/navigation";
import {
  CreateWorkspaceForm
} from "../../components/auth/CreateWorkspaceForm";
import {
  SignOutButton
} from "../../components/auth/SignOutButton";
import {
  WORKSPACE_ROLE_LABELS
} from "../../server/authorization-policy";
import {
  getDatabase
} from "../../server/db";
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

  return (
    <div className="protected-wrap">
      <header className="protected-header">
        <p className="eyebrow">
          Workspace home
        </p>

        <h1>
          Your workspaces
        </h1>

        <p>
          {memberships.length === 0
            ? "Create a workspace to get started."
            : "Choose a workspace to continue, or create another one."}
        </p>

        <p>
          Signed in as{" "}
          <strong>
            {`${sessionState.session.walletAddress.slice(0, 5)}…${sessionState.session.walletAddress.slice(-4)}`}
          </strong>
          .
        </p>
      </header>

      <div className="workspace-dashboard">
        <section
          className="workspace-dashboard__list"
          aria-labelledby="workspace-list-heading"
        >
          <div className="workspace-dashboard__section-heading">
            <div>
              <h2 id="workspace-list-heading">
                Workspace list
              </h2>
              <p>
                {memberships.length === 1
                  ? "1 workspace"
                  : `${memberships.length} workspaces`}
              </p>
            </div>
          </div>

          {memberships.length === 0 ? (
            <div className="workspace-empty-state">
              <h3>No workspaces yet</h3>
              <p>
                Create your first workspace to get started.
              </p>
            </div>
          ) : (
            <div className="workspace-grid">
              {memberships.map(
                (membership) => (
                  <article
                    className="workspace-card"
                    key={
                      membership.workspaceId
                    }
                  >
                    <div>
                      <h3>
                        {
                          membership.workspaceName
                        }
                      </h3>
                      <span className="workspace-card__role">
                        {
                          WORKSPACE_ROLE_LABELS[
                            membership.role
                          ]
                        }
                      </span>
                    </div>

                    <div className="protected-actions">
                      <Link
                        className="button"
                        href={`/workspace/${membership.workspaceId}`}
                      >
                        Open workspace
                      </Link>
                    </div>
                  </article>
                )
              )}
            </div>
          )}
        </section>

        <section
          className="invite-state workspace-create-card"
          id="create-workspace"
          aria-labelledby="create-workspace-heading"
        >
          <div>
            <p className="eyebrow">
              Add a workspace
            </p>
            <h2 id="create-workspace-heading">
              Create a workspace
            </h2>
            <p>
              Set up another workspace for a separate team or
              organization. Creating one does not activate billing.
            </p>
          </div>

          <CreateWorkspaceForm />
        </section>
      </div>

      <div className="protected-actions workspace-dashboard__footer">
        <SignOutButton />
      </div>
    </div>
  );
}