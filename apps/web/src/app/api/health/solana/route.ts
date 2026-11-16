import { NextResponse } from "next/server";
import { getSolanaHealth, SolanaRpcError } from "../../../../server/solana/rpc";
import { logServerFailure } from "../../../../server/server-error-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getSolanaHealth(), {
      headers: { "Cache-Control": "no-store" }
    });
  } catch (error) {
    if (!(error instanceof SolanaRpcError)) {
      logServerFailure("solana_health_check_failed", error);
    }
    return NextResponse.json(
      { status: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
