import { NextResponse } from "next/server";
import { getHealthStatus } from "../../../server/health";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const result = await getHealthStatus();

  if (result.statusCode !== 200) {
    console.error(
      JSON.stringify({
        event: "health_check_failed",
        code: result.payload.code
      })
    );
  }

  return NextResponse.json(result.payload, {
    status: result.statusCode,
    headers: {
      "Cache-Control": "no-store"
    }
  });
}