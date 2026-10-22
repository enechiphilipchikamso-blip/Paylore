import { NextResponse } from "next/server";
import { z } from "zod";
import {
  findWorkspaceContributorByWallet,
  getContributorConfidentialAccount,
  getContributorOffboardingStatus,
  getWorkspaceForUser,
  hasOpenContributorPayrollAllocations,
  recordContributorConfidentialAccountSetup
} from "@paylore/database";
import { getDatabase } from "../../../../../../../server/db";
import { clearSessionCookie, getSessionState } from "../../../../../../../server/session";
import { assertSameOrigin, RequestSecurityError } from "../../../../../../../server/security";
import { loadPayloreConfig } from "../../../../../../../server/config";
import {
  ConfidentialAccountVerificationError,
  verifyConfidentialAccountSetup
} from "../../../../../../../server/solana/confidential-account-verification";

const setupSchema = z.object({
  signature: z.string().min(80).max(90)
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function getContributorContext(workspaceId: string) {
  const session = await getSessionState();
  if (session.status !== "authenticated") {
    await clearSessionCookie();
    return {
      response: NextResponse.json(
        { error: "authentication_required" },
        { status: 401 }
      )
    };
  }
  const db = getDatabase();
  const membership = await getWorkspaceForUser(
    db,
    session.session.userId,
    workspaceId
  );
  if (!membership || membership.role !== "contributor") {
    return {
      response: NextResponse.json(
        { error: "workspace_access_denied" },
        { status: 403 }
      )
    };
  }
  const contributor = await findWorkspaceContributorByWallet(
    db,
    workspaceId,
    session.session.walletAddress
  );
  if (!contributor || contributor.lifecycle === "left") {
    return {
      response: NextResponse.json(
        { error: "contributor_record_not_found" },
        { status: 404 }
      )
    };
  }
  return { db, contributor, session: session.session };
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  const { workspaceId } = await params;
  const context = await getContributorContext(workspaceId);
  if ("response" in context) return context.response;
  const config = loadPayloreConfig();
  const [account, hasOpenAllocations, offboarding] = await Promise.all([
    getContributorConfidentialAccount(
      context.db,
      workspaceId,
      context.contributor.id
    ),
    hasOpenContributorPayrollAllocations(
      context.db,
      workspaceId,
      context.contributor.id
    ),
    getContributorOffboardingStatus(
      context.db,
      workspaceId,
      context.contributor.id
    )
  ]);
  return NextResponse.json(
    {
      account,
      hasOpenAllocations,
      offboarding,
      mintConfigured: Boolean(config.PAYLORE_WRAPPED_USDC_MINT),
      mint: config.PAYLORE_WRAPPED_USDC_MINT ?? null,
      walletAddress: context.session.walletAddress
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ workspaceId: string }> }
) {
  try {
    assertSameOrigin(request);
    const { workspaceId } = await params;
    const context = await getContributorContext(workspaceId);
    if ("response" in context) return context.response;

    const config = loadPayloreConfig();
    const mint = config.PAYLORE_WRAPPED_USDC_MINT;
    if (!mint) {
      return NextResponse.json(
        { error: "confidential_mint_unavailable" },
        { status: 503 }
      );
    }
    const parsed = setupSchema.safeParse(await request.json());
    if (!parsed.success) {
      return NextResponse.json(
        { error: "invalid_setup_transaction" },
        { status: 400 }
      );
    }
    const tokenAccountAddress = await verifyConfidentialAccountSetup({
      signature: parsed.data.signature,
      walletAddress: context.session.walletAddress,
      mintAddress: mint
    });
    const account = await recordContributorConfidentialAccountSetup(
      context.db,
      {
        workspaceId,
        contributorId: context.contributor.id,
        ownerWalletAddress: context.session.walletAddress,
        tokenAccountAddress,
        transactionSignature: parsed.data.signature
      }
    );
    return NextResponse.json(
      { account },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof ConfidentialAccountVerificationError) {
      return NextResponse.json({ error: error.code }, { status: 409 });
    }
    if (error instanceof RequestSecurityError) {
      return NextResponse.json({ error: "request_not_allowed" }, { status: 403 });
    }
    console.error(JSON.stringify({ event: "confidential_account_setup_failed" }));
    return NextResponse.json(
      { error: "confidential_account_setup_failed" },
      { status: 503 }
    );
  }
}
