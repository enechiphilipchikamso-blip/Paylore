import { NextResponse } from "next/server";
import { getDevnetHealth, SolanaRpcError } from "../../../../server/solana/rpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    return NextResponse.json(await getDevnetHealth(), {
      headers: { "Cache-Control": "no-store" }
    });
  } catch (error) {
    if (!(error instanceof SolanaRpcError)) {
      console.error(JSON.stringify({ event: "solana_health_check_failed" }));
    }
    return NextResponse.json(
      { network: "devnet", status: "unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } }
    );
  }
}
