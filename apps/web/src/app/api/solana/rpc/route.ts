import { NextResponse } from "next/server";
import { readSolanaRpc, SolanaRpcError } from "../../../../server/solana/rpc";
import { getSessionState } from "../../../../server/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const session = await getSessionState();
  if (session.status !== "authenticated") {
    return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON-RPC request." }, { status: 400 });
  }
  if (
    !body ||
    typeof body !== "object" ||
    typeof (body as { method?: unknown }).method !== "string" ||
    !Array.isArray((body as { params?: unknown }).params)
  ) {
    return NextResponse.json({ error: "Invalid JSON-RPC request." }, { status: 400 });
  }
  const { method, params } = body as { method: string; params: unknown[] };
  try {
    return NextResponse.json({
      jsonrpc: "2.0",
      id: (body as { id?: unknown }).id ?? null,
      result: await readSolanaRpc(method, params)
    }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (!(error instanceof SolanaRpcError)) {
      console.error(JSON.stringify({ event: "solana_rpc_proxy_failed" }));
    }
    return NextResponse.json(
      { jsonrpc: "2.0", id: (body as { id?: unknown }).id ?? null, error: { message: error instanceof Error ? error.message : "Solana RPC request failed." } },
      { status: error instanceof SolanaRpcError ? 502 : 500 }
    );
  }
}
