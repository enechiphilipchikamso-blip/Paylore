import { NextResponse } from "next/server";
import { z } from "zod";
import {
  getWorkspaceForUser,
  getWorkspaceSubscription,
  insertWorkspaceContributors,
  listWorkspaceContributors
} from "@paylore/database";
import { clearSessionCookie, getSessionState } from "../../../../../server/session";
import { assertSameOrigin, isValidSolanaAddress, RequestSecurityError } from "../../../../../server/security";
import { getDatabase } from "../../../../../server/db";

const contributorSchema = z.object({
  displayName: z.string().trim().min(1).max(120),
  identityWalletAddress: z.string().trim().min(1).max(64),
  effectivePayoutAddress: z.string().trim().min(1).max(64),
  organizationLabel: z.string().trim().max(120).optional(),
  adminNote: z.string().trim().max(2000).optional()
});

const createSchema = z.object({
  contributors: z.array(contributorSchema).min(1).max(500)
});

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

async function authorize(request: Request, workspaceId: string, mutate = false) {
  if (mutate) assertSameOrigin(request);
  const session = await getSessionState();
  if (session.status !== "authenticated") {
    await clearSessionCookie();
    return { response: NextResponse.json({ error: "authentication_required" }, { status: 401 }) };
  }
  const db = getDatabase();
  const membership = await getWorkspaceForUser(db, session.session.userId, workspaceId);
  if (!membership || membership.role === "contributor") {
    return { response: NextResponse.json({ error: "workspace_access_denied" }, { status: 403 }) };
  }
  return { db, membership, session: session.session };
}

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: RouteContext) {
  const { workspaceId } = await params;
  const access = await authorize(request, workspaceId);
  if ("response" in access) return access.response;
  return NextResponse.json({
    contributors: await listWorkspaceContributors(access.db, workspaceId)
  });
}

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const { workspaceId } = await params;
    const access = await authorize(request, workspaceId, true);
    if ("response" in access) return access.response;
    if (access.membership.role !== "organization_admin") {
      return NextResponse.json({ error: "workspace_access_denied" }, { status: 403 });
    }
    const subscription = await getWorkspaceSubscription(access.db, workspaceId);
    if (subscription?.status !== "active" && subscription?.status !== "cancel_scheduled") {
      return NextResponse.json({ error: "workspace_read_only" }, { status: 409 });
    }

    const parsed = createSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json({ error: "invalid_contributors" }, { status: 400 });
    }
    const contributors = parsed.data.contributors;
    const seen = new Set<string>();
    for (const contributor of contributors) {
      if (
        !isValidSolanaAddress(contributor.identityWalletAddress) ||
        !isValidSolanaAddress(contributor.effectivePayoutAddress) ||
        contributor.identityWalletAddress !== contributor.effectivePayoutAddress
      ) {
        return NextResponse.json({ error: "invalid_contributor_wallet" }, { status: 400 });
      }
      if (seen.has(contributor.identityWalletAddress)) {
        return NextResponse.json({ error: "duplicate_contributor_wallet" }, { status: 409 });
      }
      seen.add(contributor.identityWalletAddress);
    }

    const existing = await listWorkspaceContributors(access.db, workspaceId);
    if (existing.some((record) => seen.has(record.identityWalletAddress))) {
      return NextResponse.json({ error: "duplicate_contributor_wallet" }, { status: 409 });
    }

    const created = await insertWorkspaceContributors(access.db, workspaceId, contributors);
    return NextResponse.json({ contributors: created }, { status: 201 });
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return NextResponse.json({ error: "request_not_allowed" }, { status: 403 });
    }
    console.error(JSON.stringify({ event: "contributor_create_failed" }));
    return NextResponse.json({ error: "contributor_create_failed" }, { status: 500 });
  }
}
