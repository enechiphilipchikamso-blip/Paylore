import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { listWorkspaceDeadLetterSolanaWebhookEvents, listWorkspaceLedgerEntries } from "@paylore/database";
import { WebhookDeadLetterQueue } from "../../../../components/workspace/WebhookDeadLetterQueue";
import {
  decodeLedgerCursor,
  encodeLedgerCursor,
  LEDGER_CATEGORIES,
  LEDGER_CATEGORY_LABELS,
  LEDGER_STATUSES,
  parseLedgerDate
} from "../../../../server/ledger-policy";
import {
  WorkspaceLegalFooter,
  WorkspaceNavigation
} from "../../../../components/workspace/WorkspaceNavigation";
import { getWorkspacePageContext } from "../../../../server/workspace-page-context";

export const metadata: Metadata = {
  title: "Workspace ledger",
  robots: { index: false, follow: false }
};

export const dynamic = "force-dynamic";

type SearchParams = {
  category?: string;
  status?: string;
  from?: string;
  through?: string;
  cursor?: string;
};

function formatBaseUnits(value: string, decimals: number, asset: string) {
  const amount = BigInt(value);
  const unit = 10n ** BigInt(decimals);
  const whole = amount / unit;
  const fraction = (amount % unit)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return `${fraction ? `${whole}.${fraction}` : whole.toString()} ${asset}`;
}

function formatEntryAmount(entry: {
  amountBaseUnits: string | null;
  mint: string | null;
  category: string;
  metadata: unknown;
}) {
  if (entry.amountBaseUnits === null) return "—";
  let asset = "";
  if (
    entry.metadata &&
    typeof entry.metadata === "object" &&
    "asset" in entry.metadata &&
    typeof entry.metadata.asset === "string"
  ) {
    asset = entry.metadata.asset;
  }
  if (asset === "SOL") {
    return formatBaseUnits(entry.amountBaseUnits, 9, "SOL");
  }
  if (entry.mint || ["billing", "payroll", "recovery"].includes(entry.category)) {
    return formatBaseUnits(entry.amountBaseUnits, 6, "USDC");
  }
  return `${entry.amountBaseUnits} base units`;
}

function filterUrl(
  workspaceId: string,
  filters: {
    category?: string;
    status?: string;
    from?: string;
    through?: string;
    cursor?: string;
  }
) {
  const query = new URLSearchParams();
  if (filters.category) query.set("category", filters.category);
  if (filters.status) query.set("status", filters.status);
  if (filters.from) query.set("from", filters.from);
  if (filters.through) query.set("through", filters.through);
  if (filters.cursor) query.set("cursor", filters.cursor);
  const suffix = query.toString();
  return `/workspace/${workspaceId}/ledger${suffix ? `?${suffix}` : ""}`;
}

export default async function WorkspaceLedgerPage({
  params,
  searchParams
}: {
  params: Promise<{ workspaceId: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { workspaceId } = await params;
  const query = await searchParams;
  const context = await getWorkspacePageContext(
    workspaceId,
    `/workspace/${workspaceId}/ledger`
  );
  if (context.workspace.role === "contributor") notFound();
  if (
    (query.category &&
      !LEDGER_CATEGORIES.some((category) => category === query.category)) ||
    (query.status &&
      !LEDGER_STATUSES.some((status) => status === query.status))
  ) {
    notFound();
  }
  const decodedCursor = query.cursor
    ? decodeLedgerCursor(query.cursor)
    : null;
  if (query.cursor && !decodedCursor) notFound();
  const cursor = decodedCursor ?? undefined;
  const createdAfter = parseLedgerDate(query.from);
  const createdBefore = parseLedgerDate(query.through, true);
  if (
    createdAfter === null ||
    createdBefore === null ||
    (createdAfter && createdBefore && createdAfter >= createdBefore)
  ) {
    notFound();
  }

  const deadLetters = context.workspace.role === "organization_admin"
    ? await listWorkspaceDeadLetterSolanaWebhookEvents(context.db, { workspaceId, limit: 100 })
    : [];
  const page = await listWorkspaceLedgerEntries(context.db, {
    workspaceId,
    category: query.category,
    status: query.status,
    createdAfter: createdAfter ?? undefined,
    createdBefore: createdBefore ?? undefined,
    before: cursor,
    limit: 51
  });
  const entries = page.slice(0, 50);
  const last = entries.at(-1);
  const nextCursor =
    page.length > 50 && last
      ? encodeLedgerCursor({ createdAt: last.createdAt, id: last.id })
      : undefined;

  return (
    <div className="protected-wrap workspace-page">
      <WorkspaceNavigation
        workspaceId={workspaceId}
        workspaceName={context.workspace.workspaceName}
        role={context.workspace.role}
      />
      <header className="protected-header">
        <p className="eyebrow">Workspace records</p>
        <h2>Workspace ledger</h2>
        <p>
          Financial and operational entries for this workspace. Confirming
          webhook receipt or submitting a transaction is not the same as
          finalized ledger evidence.
        </p>
      </header>
      <section className="surface-card">
        <form action={`/workspace/${workspaceId}/ledger`} method="get">
          <label className="field">
            <span>Category</span>
            <select defaultValue={query.category ?? ""} name="category">
              <option value="">All categories</option>
              {LEDGER_CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {LEDGER_CATEGORY_LABELS[category]}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Status</span>
            <select defaultValue={query.status ?? ""} name="status">
              <option value="">All statuses</option>
              {LEDGER_STATUSES.map((status) => (
                <option key={status} value={status}>{status}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>From (UTC)</span>
            <input type="date" name="from" defaultValue={query.from} />
          </label>
          <label className="field">
            <span>Through (UTC)</span>
            <input type="date" name="through" defaultValue={query.through} />
          </label>
          <button className="button" type="submit">Apply filters</button>
          <Link
            className="button button--secondary"
            href={`/api/workspaces/${workspaceId}/ledger?${new URLSearchParams({
              ...(query.category ? { category: query.category } : {}),
              ...(query.status ? { status: query.status } : {}),
              ...(query.from ? { from: query.from } : {}),
              ...(query.through ? { through: query.through } : {}),
              format: "csv"
            }).toString()}`}
          >
            Export filtered CSV
          </Link>
        </form>
      </section>
      {context.workspace.role === "organization_admin" ? (
        <WebhookDeadLetterQueue workspaceId={workspaceId} events={deadLetters} />
      ) : null}
            <section className="surface-card" aria-labelledby="ledger-entries-title">
        <h2 id="ledger-entries-title">Entries</h2>
        {entries.length === 0 ? (
          <div className="workspace-empty-state">
            <h3>No ledger entries match</h3>
            <p>Try changing the category, status or date range, or clear the filters to review all available workspace records.</p>
            <Link className="button button--secondary" href={`/workspace/${workspaceId}/ledger`}>Clear filters</Link>
          </div>
        ) : (
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Category</th>
                  <th scope="col">Entry</th>
                  <th scope="col">Status</th>
                  <th scope="col">Amount</th>
                  <th scope="col">Reference</th>
                  <th scope="col">Transaction</th>
                </tr>
              </thead>
              <tbody>
                {entries.map((entry) => (
                  <tr key={entry.id}>
                    <td>{entry.createdAt.toLocaleString()}</td>
                    <td>
                      {LEDGER_CATEGORY_LABELS[
                        entry.category as keyof typeof LEDGER_CATEGORY_LABELS
                      ] ?? entry.category}
                    </td>
                    <td>{entry.entryType}</td>
                    <td>{entry.status}</td>
                    <td>{formatEntryAmount(entry)}</td>
                    <td>
                      {entry.referenceType && entry.referenceId
                        ? `${entry.referenceType}: ${entry.referenceId}`
                        : "—"}
                    </td>
                    <td>
                      {entry.transactionSignature ? (
                        <a
                          href={`https://explorer.solana.com/tx/${encodeURIComponent(entry.transactionSignature)}?cluster=devnet`}
                          rel="noreferrer"
                          target="_blank"
                        >
                          View on Solana Explorer
                        </a>
                      ) : "—"}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <nav aria-label="Ledger pages">
          {query.cursor ? (
            <Link className="button button--secondary" href={filterUrl(workspaceId, {
              category: query.category, status: query.status,
              from: query.from, through: query.through
            })}>
              Back to newest entries
            </Link>
          ) : null}
          {nextCursor ? (
            <Link className="button" href={filterUrl(workspaceId, {
              category: query.category, status: query.status,
              from: query.from, through: query.through,
              cursor: nextCursor
            })}>
              Next 50 entries
            </Link>
          ) : null}
        </nav>
      </section>
      <WorkspaceLegalFooter />
    </div>
  );
}
