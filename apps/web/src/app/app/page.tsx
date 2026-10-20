import type { Metadata } from "next";
import { redirect } from "next/navigation";
import {
  CreateWorkspaceForm
} from "../../components/auth/CreateWorkspaceForm";
import { OpenWorkspaceLink } from "../../components/workspace/OpenWorkspaceLink";
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

export const dynamic =
  "force-dynamic";

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
  const administrators = memberships.filter(
    (membership) => membership.role === "organization_admin"
  );
  const contributors = memberships.filter(
    (membership) => membership.role === "contributor"
  );
  const finance = memberships.filter(
    (membership) => membership.role === "finance_auditor"
  );
  const sortByWorkspaceName = <
    T extends { workspaceName: string; workspaceId: string }
  >(items: T[]) =>
    [...items].sort((left, right) =>
      left.workspaceName.localeCompare(
        right.workspaceName,
        undefined,
        { sensitivity: "base", numeric: true }
      ) || left.workspaceId.localeCompare(right.workspaceId)
    );

  return (
    <div className="protected-wrap">
      <header className="protected-header">
        <h1>
          Choose a workspace
        </h1>

        <p>
          {memberships.length === 0
            ? "You do not have a workspace membership yet. Create a workspace to begin."
            : "Workspace access is determined by your authenticated membership. Selecting a workspace does not change your role or authorization."}
        </p>

        <p>
          Signed in as{" "}
          <strong>
            {`${sessionState.session.walletAddress.slice(0, 5)}…${sessionState.session.walletAddress.slice(-4)}`}
          </strong>
          .
        </p>
      </header>

      <div className="workspace-memberships">
        <div className="workspace-dashboard">
          <section
            className="workspace-dashboard__list"
            aria-labelledby="workspace-list-heading"
          >
            <div className="workspace-dashboard__section-heading">
              <h2 id="workspace-list-heading">Your workspace memberships</h2>
            </div>

            {memberships.length === 0 ? (
              <div className="workspace-empty-state">
                <h3>No workspace membership yet</h3>
                <p>Create a workspace to begin.</p>
              </div>
            ) : null}
            {[
              { title: "Workspaces as Administrator", items: administrators },
              { title: "Workspaces as Contributor", items: contributors },
              { title: "Workspaces as Finance/Auditor", items: finance }
            ].map((group) => group.items.length > 0 ? (
              <section className="workspace-role-group" key={group.title}>
                <h3>{group.title}</h3>
                <div className="workspace-grid">
                  {sortByWorkspaceName(group.items).map((membership) => (
                    <article className="workspace-card" key={membership.workspaceId}>
                      <div>
                        <h4>{membership.workspaceName}</h4>
                        <span className="workspace-card__role">
                          {WORKSPACE_ROLE_LABELS[membership.role]}
                        </span>
                      </div>
                      <OpenWorkspaceLink workspaceId={membership.workspaceId} />
                    </article>
                  ))}
                </div>
              </section>
            ) : null)}
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
                organization.
              </p>
            </div>

            <CreateWorkspaceForm />
          </section>
        </div>
      </div>

      <div className="protected-actions workspace-dashboard__footer">
        <SignOutButton />
      </div>
    </div>
  );
}