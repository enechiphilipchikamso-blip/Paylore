import { NextResponse } from "next/server";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { getWorkspaceForUser } from "@paylore/database";
import { getDatabase } from "../../../../../../server/db";
import { loadPayloreConfig } from "../../../../../../server/config";
import {
  assertSameOrigin,
  isValidSolanaAddress,
  RequestSecurityError
} from "../../../../../../server/security";
import { getSessionState, clearSessionCookie } from "../../../../../../server/session";
import { readSolanaRpc, SolanaRpcError } from "../../../../../../server/solana/rpc";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

const SPL_TOKEN_PROGRAM_ADDRESS = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  request: Request,
  { params }: RouteContext
) {
  try {
    assertSameOrigin(request);
    const session = await getSessionState();
    if (session.status !== "authenticated") {
      await clearSessionCookie();
      return NextResponse.json(
        { error: "authentication_required" },
        { status: 401 }
      );
    }

    const { workspaceId } = await params;
    const membership = await getWorkspaceForUser(
      getDatabase(),
      session.session.userId,
      workspaceId
    );
    if (!membership || membership.role !== "organization_admin") {
      return NextResponse.json(
        { error: "workspace_access_denied" },
        { status: 403 }
      );
    }

    const config = loadPayloreConfig();
    if (
      !config.PAYLORE_SUBSCRIPTION_RECIPIENT ||
      !config.PAYLORE_SUBSCRIPTION_USDC_MINT ||
      !isValidSolanaAddress(config.PAYLORE_SUBSCRIPTION_RECIPIENT) ||
      !isValidSolanaAddress(config.PAYLORE_SUBSCRIPTION_USDC_MINT)
    ) {
      return NextResponse.json(
        { error: "payment_configuration_incomplete" },
        { status: 503 }
      );
    }

    const mintAddress = config.PAYLORE_SUBSCRIPTION_USDC_MINT;
    const [latest, mintAccount] = await Promise.all([
      readSolanaRpc<{
        context: { slot: number };
        value: {
          blockhash: string;
          lastValidBlockHeight: number;
        };
      }>("getLatestBlockhash", [{ commitment: "confirmed" }]),
      readSolanaRpc<{
        value: { owner: string } | null;
      }>("getAccountInfo", [mintAddress, {
        commitment: "confirmed",
        encoding: "base64"
      }])
    ]);

    const supportedTokenPrograms = new Set<string>([
      SPL_TOKEN_PROGRAM_ADDRESS,
      TOKEN_2022_PROGRAM_ADDRESS
    ]);
    if (
      !mintAccount.value ||
      !supportedTokenPrograms.has(mintAccount.value.owner)
    ) {
      return NextResponse.json(
        { error: "payment_configuration_incomplete" },
        { status: 503 }
      );
    }

    return NextResponse.json(
      {
        payer: session.session.walletAddress,
        recipient: config.PAYLORE_SUBSCRIPTION_RECIPIENT,
        mint: mintAddress,
        tokenProgram: mintAccount.value.owner,
        blockhash: latest.value.blockhash,
        lastValidBlockHeight: latest.value.lastValidBlockHeight
      },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return NextResponse.json(
        { error: "request_not_allowed" },
        { status: 403 }
      );
    }
    if (error instanceof SolanaRpcError) {
      return NextResponse.json(
        { error: "devnet_temporarily_unavailable" },
        { status: 503 }
      );
    }
    console.error(
      JSON.stringify({ event: "subscription_payment_preparation_failed" })
    );
    return NextResponse.json(
      { error: "payment_preparation_failed" },
      { status: 500 }
    );
  }
}
