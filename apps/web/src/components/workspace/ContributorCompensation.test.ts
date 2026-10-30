import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  push: vi.fn()
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: mocks.refresh, push: mocks.push })
}));
vi.mock("./authenticated-wallet", () => ({ findAuthenticatedWallet: vi.fn() }));
vi.mock("./claim-and-cash-out-setup", () => ({ ensureClaimAndCashOutAccount: vi.fn() }));
vi.mock("./claim-and-cash-out-outcome", () => ({
  getClaimAndCashOutOutcome: vi.fn(() => ({ state: "success", text: "test-only outcome" }))
}));
vi.mock("./confidential-balance-policy", () => ({
  assertConfidentialWithdrawalAvailable: vi.fn()
}));
vi.mock("./confidential-account-transaction", () => ({
  applyConfidentialPendingBalance: vi.fn(),
  closeConfidentialAccount: vi.fn(),
  getConfidentialBalances: vi.fn(),
  setupConfidentialAccount: vi.fn(),
  unwrapWrappedUsdcToCircleUsdc: vi.fn(),
  verifyWrappedUsdcUnwrapCompatibility: vi.fn(),
  withdrawConfidentialBalance: vi.fn()
}));

import { ContributorCompensation } from "./ContributorCompensation";
import type { ComponentProps } from "react";

type Props = ComponentProps<typeof ContributorCompensation>;

const baseProps: Props = {
  workspaceId: "workspace-a",
  walletAddress: "contributor-wallet-a",
  mint: "wrapped-usdc-mint",
  circleMint: "circle-usdc-mint",
  tokenWrapProgramId: "token-wrap-program",
  tokenWrapUnwrapEnabled: false,
  account: {
    ownerWalletAddress: "contributor-wallet-a",
    tokenAccountAddress: "confidential-account-a",
    status: "ready",
    setupTransactionSignature: null,
    closeTransactionSignature: null
  },
  allocations: [
    {
      id: "allocation-unclaimed",
      runId: "run-unclaimed",
      runCreatedAt: "2026-10-01T00:00:00.000Z",
      amountBaseUnits: "1250000",
      status: "unclaimed",
      claimAddress: "claim-pda-unclaimed",
      transactionSignature: "claim-creation-unclaimed",
      claimedAt: null,
      recoveredAt: null,
      settlementSignature: null
    },
    {
      id: "allocation-pending",
      runId: "run-pending",
      runCreatedAt: "2026-10-02T00:00:00.000Z",
      amountBaseUnits: "2000000",
      status: "settlement_pending",
      claimAddress: "claim-pda-pending",
      transactionSignature: "claim-creation-pending",
      claimedAt: null,
      recoveredAt: null,
      settlementSignature: "settlement-pending-signature"
    },
    {
      id: "allocation-claimed",
      runId: "run-claimed",
      runCreatedAt: "2026-10-03T00:00:00.000Z",
      amountBaseUnits: "3000000",
      status: "claimed",
      claimAddress: "claim-pda-claimed",
      transactionSignature: "claim-creation-claimed",
      claimedAt: "2026-10-03T12:00:00.000Z",
      recoveredAt: null,
      settlementSignature: "finalized-settlement-signature"
    },
    {
      id: "allocation-recovered",
      runId: "run-recovered",
      runCreatedAt: "2026-10-04T00:00:00.000Z",
      amountBaseUnits: "4000000",
      status: "recovered",
      claimAddress: "claim-pda-recovered",
      transactionSignature: "claim-creation-recovered",
      claimedAt: null,
      recoveredAt: "2026-10-04T12:00:00.000Z",
      settlementSignature: null
    }
  ],
  hasOpenAllocations: true,
  offboardingRequested: true
};

function render(props: Props = baseProps): string {
  return renderToStaticMarkup(createElement(ContributorCompensation, props));
}

describe("ContributorCompensation rendered settlement states", () => {
  it("renders entitled, pending, settled, and recovered outcomes distinctly", () => {
    const html = render();

    expect(html).toContain("Claim &amp; Cash Out");
    expect(html).toContain("Unclaimed — no transfer recorded");
    expect(html).toContain("Settlement pending — settlement-pending-signature");
    expect(html).toContain("Settled");
    expect(html).toContain("finalized-settlement-signature");
    expect(html).toContain("Recovered");
    expect(html).toContain("An unclaimed Claim PDA is an entitlement, not a payment.");
    expect(html).toContain("Your workspace administrator asked you to review leaving this workspace.");
  });

  it("renders confidential pending and available balances as unknown until refreshed", () => {
    const html = render();

    expect(html).toContain("Pending confidential balance");
    expect(html).toContain("Available confidential balance");
    expect(html).toContain("Refresh to check");
    expect(html).not.toContain("0 wrapped USDC");
  });

  it("renders only the allocations supplied for the signed-in contributor", () => {
    const ownAllocation = baseProps.allocations[0]!;
    const html = render({ ...baseProps, allocations: [ownAllocation] });

    expect(html).toContain("run-unclaimed");
    expect(html).toContain("claim-pda-unclaimed");
    expect(html).not.toContain("run-pending");
    expect(html).not.toContain("claim-pda-pending");
    expect(html).not.toContain("finalized-settlement-signature");
  });

  it("does not offer a claim action when no allocation is present", () => {
    const html = render({ ...baseProps, allocations: [], hasOpenAllocations: false });

    expect(html).toContain("No payroll allocations yet");
    expect(html).toContain("When your workspace administrator records payroll for your wallet");
    expect(html).toContain("workspace-empty-state");
    expect(html).not.toContain("Claim &amp; Cash Out");
  });
});
