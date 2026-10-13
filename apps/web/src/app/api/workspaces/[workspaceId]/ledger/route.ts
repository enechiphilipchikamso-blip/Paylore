import { NextResponse } from "next/server";
import {
  getWorkspaceForUser,
  listWorkspaceLedgerEntries
} from "@paylore/database";
import { clearSessionCookie, getSessionState } from "../../../../../server/session";
import { getDatabase } from "../../../../../server/db";
import {
  csvCell,
  decodeLedgerCursor,
  encodeLedgerCursor,
  type LedgerCursor,
  LEDGER_CATEGORIES,
  LEDGER_STATUSES,
  parseLedgerDate
} from "../../../../../server/ledger-policy";

type RouteContext = {
  params: Promise<{ workspaceId: string }>;
};

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isOneOf<T extends readonly string[]>(
  values: T,
  value: string | undefined
): boolean {
  return value === undefined || values.some((candidate) => candidate === value);
}

function parseFilters(url: URL) {
  const category = url.searchParams.get("category") || undefined;
  const status = url.searchParams.get("status") || undefined;
  const createdAfter = parseLedgerDate(url.searchParams.get("from"));
  const createdBefore = parseLedgerDate(
    url.searchParams.get("through"),
    true
  );
  const cursorValue = url.searchParams.get("cursor");
  const limitValue = url.searchParams.get("limit") ?? "50";
  const limit = Number(limitValue);
  if (
    !isOneOf(LEDGER_CATEGORIES, category) ||
    !isOneOf(LEDGER_STATUSES, status) ||
    createdAfter === null ||
    createdBefore === null ||
    (createdAfter && createdBefore && createdAfter >= createdBefore) ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 100
  ) {
    return null;
  }
  let cursor: LedgerCursor | undefined;
  if (cursorValue) {
    const decoded = decodeLedgerCursor(cursorValue);
    if (!decoded) return null;
    cursor = decoded;
  }
  return {
    category,
    status,
    createdAfter: createdAfter ?? undefined,
    createdBefore: createdBefore ?? undefined,
    cursor,
    limit
  };
}

export async function GET(request: Request, { params }: RouteContext) {
  const { workspaceId } = await params;
  const session = await getSessionState();
  if (session.status !== "authenticated") {
    await clearSessionCookie();
    return NextResponse.json(
      { error: "authentication_required" },
      { status: 401 }
    );
  }
  const db = getDatabase();
  const workspace = await getWorkspaceForUser(
    db,
    session.session.userId,
    workspaceId
  );
  if (!workspace || workspace.role === "contributor") {
    return NextResponse.json(
      { error: "workspace_access_denied" },
      { status: 403 }
    );
  }

  const url = new URL(request.url);
  const format = url.searchParams.get("format");
  if (format && format !== "csv") {
    return NextResponse.json({ error: "invalid_export_format" }, { status: 400 });
  }
  const filters = parseFilters(url);
  if (!filters) {
    return NextResponse.json({ error: "invalid_ledger_filter" }, { status: 400 });
  }

  try {
    if (format === "csv") {
      const rows: string[] = [
        [
          "createdAt",
          "category",
          "entryType",
          "status",
          "amountBaseUnits",
          "mint",
          "transactionSignature",
          "referenceType",
          "referenceId"
        ].map(csvCell).join(",")
      ];
      let cursor: typeof filters.cursor;
      let hasMore = false;
      do {
        const page = await listWorkspaceLedgerEntries(db, {
          workspaceId,
          category: filters.category,
          status: filters.status,
          createdAfter: filters.createdAfter,
          createdBefore: filters.createdBefore,
          before: cursor,
          limit: 101
        });
        hasMore = page.length > 100;
        const visible = page.slice(0, 100);
        for (const entry of visible) {
          rows.push([
            entry.createdAt.toISOString(),
            entry.category,
            entry.entryType,
            entry.status,
            entry.amountBaseUnits ?? "",
            entry.mint ?? "",
            entry.transactionSignature ?? "",
            entry.referenceType ?? "",
            entry.referenceId ?? ""
          ].map(csvCell).join(","));
        }
        if (hasMore && rows.length - 1 >= 5000) {
          return NextResponse.json(
            { error: "export_too_large_narrow_filters" },
            { status: 413 }
          );
        }
        const last = visible.at(-1);
        cursor = hasMore && last
          ? { createdAt: last.createdAt, id: last.id }
          : undefined;
      } while (hasMore);

      return new Response(`${rows.join("\r\n")}\r\n`, {
        headers: {
          "Cache-Control": "no-store",
          "Content-Disposition": `attachment; filename="paylore-ledger-${workspaceId}.csv"`,
          "Content-Type": "text/csv; charset=utf-8"
        }
      });
    }

    const page = await listWorkspaceLedgerEntries(db, {
      workspaceId,
      category: filters.category,
      status: filters.status,
      createdAfter: filters.createdAfter,
      createdBefore: filters.createdBefore,
      before: filters.cursor,
      limit: filters.limit + 1
    });
    const entries = page.slice(0, filters.limit);
    const last = entries.at(-1);
    const nextCursor =
      page.length > filters.limit && last
        ? encodeLedgerCursor({
            createdAt: last.createdAt,
            id: last.id
          })
        : null;
    return NextResponse.json(
      { entries, nextCursor },
      { headers: { "Cache-Control": "no-store" } }
    );
  } catch {
    console.error(JSON.stringify({ event: "workspace_ledger_query_failed" }));
    return NextResponse.json(
      { error: "workspace_ledger_unavailable" },
      { status: 503 }
    );
  }
}
