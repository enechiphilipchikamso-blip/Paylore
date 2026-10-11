import "server-only";

import { notFound, redirect } from "next/navigation";
import { getWorkspaceForUser } from "@paylore/database";
import { getDatabase } from "./db";
import { getSessionState } from "./session";

export async function getWorkspacePageContext(
  workspaceId: string,
  returnPath = `/workspace/${workspaceId}`
) {
  const session = await getSessionState();
  if (session.status !== "authenticated") {
    const reason =
      session.status === "inactivity_expired"
        ? "inactivity-expired"
        : session.status === "hard_expired"
          ? "hard-expired"
          : undefined;
    const query = new URLSearchParams({ next: returnPath });
    if (reason) query.set("reason", reason);
    redirect(`/auth?${query.toString()}`);
  }

  const db = getDatabase();
  const workspace = await getWorkspaceForUser(
    db,
    session.session.userId,
    workspaceId
  );
  if (!workspace) notFound();

  return {
    db,
    session: session.session,
    workspace
  };
}
