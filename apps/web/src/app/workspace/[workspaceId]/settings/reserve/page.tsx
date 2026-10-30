import type { Metadata } from "next";
import { notFound } from "next/navigation";
import {
  getWorkspaceReserve,
  getWorkspaceSubscription
} from "@paylore/database";
import {
  WorkspaceLegalFooter,
  WorkspaceNavigation
} from "../../../../../components/workspace/WorkspaceNavigation";
import { ReserveActions } from "../../../../../components/workspace/ReserveActions";
import { getWorkspacePageContext } from "../../../../../server/workspace-page-context";
import { getWorkspaceGasTankSnapshot } from "../../../../../server/gas-tank";

export const metadata: Metadata = {
  title: "Confidential payroll reserve",
  robots: { index: false, follow: false }
};

export const dynamic = "force-dynamic";

type GasTankReservePreflight = {
  status: "not_initialized" | "funding_required" | "ready" | "unavailable";
  address: string | null;
  balanceSol: string | null;
};

function formatSolBalance(lamports: string): string | null {
  try {
    const value = BigInt(lamports);
    if (value < 0n) return null;
    const whole = value / 1_000_000_000n;
    const fraction = (value % 1_000_000_000n)
      .toString()
      .padStart(9, "0")
      .replace(/0+$/, "");
    return fraction ? `${whole}.${fraction}` : whole.toString();
  } catch {
    return null;
  }
}

export default async function WorkspaceReservePage({
  params
}: {
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const context = await getWorkspacePageContext(
    workspaceId,
    `/workspace/${workspaceId}/settings/reserve`
  );
  if (context.workspace.role !== "organization_admin") notFound();
  const [reserve, subscription, gasTankResult] = await Promise.all([
    getWorkspaceReserve(context.db, workspaceId),
    getWorkspaceSubscription(context.db, workspaceId),
    getWorkspaceGasTankSnapshot(context.db, workspaceId)
      .then((snapshot) => ({ ok: true as const, snapshot }))
      .catch(() => ({ ok: false as const, snapshot: null }))
  ]);
  const gasTankPreflight: GasTankReservePreflight = !gasTankResult.ok
    ? { status: "unavailable", address: null, balanceSol: null }
    : !gasTankResult.snapshot
      ? { status: "not_initialized", address: null, balanceSol: null }
      : (() => {
          const balanceSol = formatSolBalance(gasTankResult.snapshot.balanceLamports);
          if (balanceSol === null) {
            return {
              status: "unavailable" as const,
              address: gasTankResult.snapshot.address,
              balanceSol: null
            };
          }
          return {
            status: gasTankResult.snapshot.lowBalance ? "funding_required" as const : "ready" as const,
            address: gasTankResult.snapshot.address,
            balanceSol
          };
        })();
  const canInitialize =
    subscription?.status === "active" ||
    subscription?.status === "cancel_scheduled";

  return (
    <div className="protected-wrap workspace-page">
      <WorkspaceNavigation
        workspaceId={workspaceId}
        workspaceName={context.workspace.workspaceName}
        role={context.workspace.role}
      />
      <header className="protected-header">
        <p className="eyebrow">Settings</p>
        <h2>Confidential payroll reserve</h2>
        <p>
          This workspace has a dedicated reserve signing address. Its private
          key is protected on the server and never delivered to the browser.
          Key custody alone does not create or fund an on-chain confidential
          reserve. Initialize the workspace Gas Tank and fund it with SOL first;
          the Gas Tank pays Reserve setup transaction fees and account rent.
          The Reserve remains the token-account owner and signs as the authority
          where required. Configure the reserve-owned Token-2022 account and
          matching Payroll Program reserve state, then fund it with the
          configured wrapped-USDC mint. A payroll claim is reported settled only
          after its confidential transfer reaches finality and the reserve debit
          is reconciled.
        </p>
      </header>
      <section className="surface-card">
        {!canInitialize && !reserve ? (
          <div className="state-callout" data-state="partial">
            <span className="state-callout__signal" aria-hidden="true" />
            <p>Activate or renew the workspace before initializing its reserve.</p>
          </div>
        ) : null}
        <ReserveActions
          workspaceId={workspaceId}
          canInitialize={canInitialize}
          gasTankPreflight={gasTankPreflight}
          reserve={reserve
            ? {
                address: reserve.address,
                createdAt: reserve.createdAt.toISOString(),
                updatedAt: reserve.updatedAt.toISOString()
              }
            : null}
        />
      </section>
      <WorkspaceLegalFooter />
    </div>
  );
}
