import { NextResponse } from "next/server";
import { z } from "zod";
import { getSessionState } from "../../../../server/session";
import { assertSameOrigin, RequestSecurityError } from "../../../../server/security";
import { readSolanaRpc, SolanaRpcError } from "../../../../server/solana/rpc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Same-origin JSON-RPC relay so browser code uses the configured providers without
 * exposing provider URLs or keys. Only methods the workspace client code needs are relayed.
 */
const BROWSER_METHODS = new Set([
  "getAccountInfo",
  "getBalance",
  "getLatestBlockhash",
  "getMinimumBalanceForRentExemption",
  "getMultipleAccounts",
  "getSignatureStatuses",
  "getTokenAccountBalance",
  "getTokenSupply",
  "sendTransaction",
  "simulateTransaction"
]);

const requestSchema = z.object({
  jsonrpc: z.literal("2.0"),
  id: z.union([z.string().max(128), z.number()]),
  method: z.string().max(64),
  params: z.array(z.unknown()).max(8).optional()
});

const MAX_BODY_BYTES = 64 * 1024;

export async function POST(request: Request) {
  try {
    assertSameOrigin(request);
  } catch (error) {
    if (error instanceof RequestSecurityError) {
      return NextResponse.json({ error: "request_not_allowed" }, { status: 403 });
    }
    throw error;
  }
  const session = await getSessionState();
  if (session.status !== "authenticated") {
    return NextResponse.json({ error: "authentication_required" }, { status: 401 });
  }
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) {
    return NextResponse.json({ error: "request_too_large" }, { status: 413 });
  }
  let raw: unknown;
  try { raw = JSON.parse(text); } catch {
    return NextResponse.json({ error: "invalid_rpc_request" }, { status: 400 });
  }
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success || !BROWSER_METHODS.has(parsed.data.method)) {
    return NextResponse.json({ error: "invalid_rpc_request" }, { status: 400 });
  }
  const { id, method, params = [] } = parsed.data;
  try {
    const result = await readSolanaRpc<unknown>(method, params);
    return NextResponse.json({ jsonrpc: "2.0", id, result }, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    if (error instanceof SolanaRpcError) {
      return NextResponse.json({
        jsonrpc: "2.0",
        id,
        error: error.rpcError ?? { code: -32603, message: error.message }
      }, { headers: { "Cache-Control": "no-store" } });
    }
    console.error(JSON.stringify({ event: "browser_solana_rpc_failed" }));
    return NextResponse.json({ error: "solana_rpc_unavailable" }, { status: 503 });
  }
}
