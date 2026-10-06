import type { Metadata } from "next";
import Link from "next/link";
import {
  PublicPage
} from "../../../components/public/PublicPage";
import {
  InvitationActions
} from "../../../components/auth/InvitationActions";
import {
  findInvitationEntry,
  invitationWalletMatches
} from "../../../server/invitations";
import {
  getDatabase
} from "../../../server/db";
import {
  getSessionState
} from "../../../server/session";

export const metadata: Metadata = {
  title: "Invitation",
  robots: {
    index: false,
    follow: false
  }
};

export const dynamic =
  "force-dynamic";

export default async function InvitationEntryPage({
  params
}: {
  params: Promise<{
    token: string;
  }>;
}) {
  const { token } =
    await params;

  const invitation =
    await findInvitationEntry(
      getDatabase(),
      token
    );

  if (!invitation) {
    return (
      <PublicPage
        eyebrow="Invitation"
        title="Invitation unavailable"
        description="This invitation is invalid or has expired."
      >
        <div
          className="error-box"
          role="alert"
        >
          The invitation could not be
          validated.
        </div>
      </PublicPage>
    );
  }

  const sessionState =
    await getSessionState();

  const authPath =
    `/auth?next=${encodeURIComponent(
      `/invite/${token}`
    )}`;

  if (
    sessionState.status ===
    "unauthenticated"
  ) {
    return (
      <PublicPage
        eyebrow="Invitation"
        title="Sign in to verify this invitation"
        description={`This invitation targets the ${invitation.workspaceName} workspace.`}
      >
        <div className="invite-state">
          <h2>
            Authentication is required
          </h2>

          <p>
            Possessing this link does not
            grant access. Connect and
            authenticate the wallet associated
            with the invitation target.
          </p>

          <Link
            className="button"
            href={authPath}
          >
            Sign in to continue
          </Link>
        </div>
      </PublicPage>
    );
  }

  if (
    sessionState.status ===
    "inactivity_expired"
  ) {
    return (
      <PublicPage
        eyebrow="Invitation"
        title="Re-authentication required"
        description="Your previous session expired after 12 hours of inactivity."
      >
        <div className="invite-state">
          <Link
            className="button"
            href={`/auth?reason=inactivity-expired&next=${encodeURIComponent(
              `/invite/${token}`
            )}`}
          >
            Sign in again
          </Link>
        </div>
      </PublicPage>
    );
  }

  if (
    sessionState.status ===
    "hard_expired"
  ) {
    return (
      <PublicPage
        eyebrow="Invitation"
        title="Fresh sign-in required"
        description="Your previous session reached its 7-day maximum lifetime."
      >
        <div className="invite-state">
          <Link
            className="button"
            href={`/auth?reason=hard-expired&next=${encodeURIComponent(
              `/invite/${token}`
            )}`}
          >
            Sign in again
          </Link>
        </div>
      </PublicPage>
    );
  }

  const walletMatches =
    invitationWalletMatches(
      invitation.contributorWalletAddress,
      sessionState.session.walletAddress
    );

  if (!walletMatches) {
    return (
      <PublicPage
        eyebrow="Invitation"
        title="Wrong Wallet Connected"
        description="The authenticated wallet does not match the wallet associated with this invitation target."
      >
        <div
          className="invite-state"
          role="alert"
        >
          <p>
            Switch to the wallet associated
            with this invitation, then retry
            verification.
          </p>

          <InvitationActions
            authPath={authPath}
            retryPath={`/invite/${token}`}
          />
        </div>
      </PublicPage>
    );
  }

  return (
    <PublicPage
      eyebrow="Invitation"
      title="Invitation wallet verified"
      description={`The authenticated wallet matches the invitation target for ${invitation.workspaceName}.`}
    >
      <div className="invite-state">
        <div
          className="success-box"
          role="status"
        >
          Wallet verification succeeded.
        </div>

        <p>
          The invitation target has been
          verified for the authenticated
          wallet. Invitation issuance and
          contributor management are handled
          separately.
        </p>

        <p className="workspace-card__meta">
          Target workspace ID:{" "}
          {invitation.workspaceId}
        </p>

        <Link
          className="button button--secondary"
          href="/app"
        >
          Continue to workspace gateway
        </Link>
      </div>
    </PublicPage>
  );
}