import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("next/link", () => ({
  default: ({ href, children, className }: {
    href: string;
    children: unknown;
    className?: string;
  }) => <a href={href} className={className}>{children as never}</a>
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn() })
}));

import {
  canFundReserveWithOrdinaryUsdc,
  canStartOrdinaryUsdcReserveFunding,
  getReserveFundingOutcomeMessage,
  gasTankAllowsReserveInitialization,
  getReserveActionErrorMessage,
  ReserveActions
} from "./ReserveActions";

const baseProps = {
  workspaceId: "workspace-a",
  canInitialize: true,
  reserve: {
    address: "reserve-address",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-02T00:00:00.000Z"
  }
};

describe("ReserveActions ordinary-USDC funding gate", () => {
  it("only enables wrapping into a verified configured Reserve", () => {
    expect(canFundReserveWithOrdinaryUsdc("program_configured", true)).toBe(true);
    expect(canFundReserveWithOrdinaryUsdc("confidential_account_ready", true)).toBe(false);
    expect(canFundReserveWithOrdinaryUsdc("account_missing", false)).toBe(false);
    expect(canFundReserveWithOrdinaryUsdc("not_checked", true)).toBe(false);
  });
});

describe("ReserveActions confidential funding outcomes", () => {
  it("explains when the Reserve funding retry limit is reached", () => {
    const notice = getReserveFundingOutcomeMessage({
      status: "error",
      errorCode: "reserve_confidential_funding_retry_limit"
    });
    expect(notice.state).toBe("error");
    expect(notice.text).toContain("reached its retry limit");
    expect(notice.text).toContain("contact support");
  });

  it("explains when the Gas Tank reaches the 24-hour sponsorship ceiling", () => {
    const notice = getReserveFundingOutcomeMessage({
      status: "error",
      errorCode: "reserve_gas_tank_daily_sponsorship_limit"
    });
    expect(notice.state).toBe("error");
    expect(notice.text).toContain("24-hour sponsorship limit");
    expect(notice.text).toContain("Continue this same Reserve funding operation");
    expect(notice.text).toContain("do not wrap USDC again");
  });

  it("does not suggest another wallet wrap when the fee reservation service is unavailable", () => {
    const notice = getReserveFundingOutcomeMessage({
      status: "error",
      errorCode: "reserve_gas_tank_sponsorship_unavailable"
    });
    expect(notice.state).toBe("error");
    expect(notice.text).toContain("No confidential Reserve transaction was submitted");
    expect(notice.text).toContain("do not wrap USDC again");
  });
  it("shows a distinct recoverable status while the public wrap is awaiting finality", () => {
    const notice = getReserveFundingOutcomeMessage({
      status: "pending",
      phase: "wrap_pending"
    });
    expect(notice.state).toBe("partial");
    expect(notice.text).toContain("ordinary-USDC wrap was submitted");
    expect(notice.text).toContain("saved its signature");
    expect(notice.text).toContain("do not submit another wrap");
  });

  it("distinguishes a verified public wrap from an unfinished confidential deposit", () => {
    const notice = getReserveFundingOutcomeMessage({
      status: "pending",
      phase: "wrap_verified"
    });
    expect(notice.state).toBe("partial");
    expect(notice.text).toContain("wrap is finalized and verified");
    expect(notice.text).toContain("has not yet confirmed a confidential deposit");
  });

  it("keeps an unfinished apply operation resumable without asking for another wrap", () => {
    const notice = getReserveFundingOutcomeMessage({
      status: "pending",
      phase: "apply"
    });
    expect(notice.state).toBe("partial");
    expect(notice.text).toContain("pending confidential balance");
    expect(notice.text).toContain("Continue this same operation");
    expect(notice.text).toContain("do not wrap again");
  });

  it("asks the administrator to fund the Gas Tank and resume the same operation", () => {
    const notice = getReserveFundingOutcomeMessage({
      status: "error",
      errorCode: "reserve_gas_tank_insufficient_funds"
    });
    expect(notice.state).toBe("error");
    expect(notice.text).toContain("Fund the Gas Tank");
    expect(notice.text).toContain("continue this same operation");
    expect(notice.text).toContain("do not wrap USDC again");
  });

  it("claims confidential funding only after the deposit and apply balances are verified", () => {
    const notice = getReserveFundingOutcomeMessage({
      status: "confidential_balance_verified"
    });
    expect(notice.state).toBe("success");
    expect(notice.text).toContain("deposited into the Reserve's confidential pending balance");
    expect(notice.text).toContain("applied to its available confidential balance");
    expect(notice.text).toContain("verified the finalized on-chain balances");
  });
});

describe("ReserveActions Gas Tank funding gate", () => {
  it("does not ask the administrator to wrap USDC until Gas Tank custody and balance are ready", () => {
    expect(canStartOrdinaryUsdcReserveFunding("program_configured", true, "ready")).toBe(true);
    expect(canStartOrdinaryUsdcReserveFunding("program_configured", true, "funding_required")).toBe(true);
    expect(canStartOrdinaryUsdcReserveFunding("program_configured", true, "not_initialized")).toBe(false);
    expect(canStartOrdinaryUsdcReserveFunding("program_configured", true, "unavailable")).toBe(false);
    expect(canStartOrdinaryUsdcReserveFunding("account_missing", false, "ready")).toBe(false);
  });
});

describe("ReserveActions Gas Tank preflight", () => {
  it("blocks initialization until the Gas Tank exists and its live balance is verifiable", () => {
    expect(gasTankAllowsReserveInitialization("not_initialized")).toBe(false);
    expect(gasTankAllowsReserveInitialization("unavailable")).toBe(false);
    expect(gasTankAllowsReserveInitialization("ready")).toBe(true);
  });

  it("maps insufficient Gas Tank funding to a specific next action", () => {
    expect(getReserveActionErrorMessage(
      "reserve_gas_tank_insufficient_funds",
      "initialize_confidential"
    )).toBe(
      "The workspace Gas Tank does not have enough SOL to cover Reserve setup fees and reserve account rent. Fund the Gas Tank, then retry."
    );
  });

  it("tells users to reconcile Reserve state when Gas Tank balance verification fails", () => {
    const message = getReserveActionErrorMessage(
      "reserve_gas_tank_balance_unavailable",
      "initialize_confidential"
    );
    expect(message).toContain("Reserve setup may be partially complete");
    expect(message).toContain("refresh the Gas Tank and Reserve status");
    expect(message).not.toContain("No transaction was submitted");
    expect(message).not.toContain("could not be verified");
  });

  it("does not replace an unrecognized operation error with the previous misleading message", () => {
    const message = getReserveActionErrorMessage(
      "some_future_error",
      "initialize_confidential"
    );
    expect(message).toContain("check any submitted transaction before trying again");
    expect(message).not.toBe("The confidential reserve operation could not be verified. Check the current on-chain state before retrying.");
  });

  it("requires Gas Tank setup before enabling confidential Reserve initialization", () => {
    const html = renderToStaticMarkup(
      <ReserveActions
        {...baseProps}
        gasTankPreflight={{
          status: "not_initialized",
          address: null,
          balanceSol: null
        }}
      />
    );

    expect(html).toContain("Gas Tank funding comes first");
    expect(html).toContain("Initialize the workspace Gas Tank and fund it with SOL");
    expect(html).toContain('href="/workspace/workspace-a/gas-tank"');
    expect(html).toContain("Set up Gas Tank");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Initialize confidential reserve<\/button>/);
  });

  it("asks the administrator to review a low Gas Tank balance without treating the threshold as a fee quote", () => {
    const html = renderToStaticMarkup(
      <ReserveActions
        {...baseProps}
        gasTankPreflight={{
          status: "funding_required",
          address: "gas-tank-address",
          balanceSol: "0.03"
        }}
      />
    );

    expect(html).toContain("current Gas Tank balance is 0.03 SOL");
    expect(html).toContain("This threshold is a warning, not a fee quote");
    expect(html).toContain("Review and fund Gas Tank");
  });

  it("fails closed when the live Gas Tank balance could not be verified", () => {
    const html = renderToStaticMarkup(
      <ReserveActions
        {...baseProps}
        gasTankPreflight={{
          status: "unavailable",
          address: null,
          balanceSol: null
        }}
      />
    );

    expect(html).toContain("could not verify the current live SOL balance for the Gas Tank");
    expect(html).toContain("Confidential Reserve initialization is disabled");
    expect(html).toContain('href="/workspace/workspace-a/gas-tank"');
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Initialize confidential reserve<\/button>/);
  });

  it("allows the exact server-side balance check to decide whether a low-balance warning is actually insufficient", () => {
    expect(gasTankAllowsReserveInitialization("funding_required")).toBe(true);
  });

  it("shows the live Gas Tank balance and states that exact rent and fees are rechecked", () => {
    const html = renderToStaticMarkup(
      <ReserveActions
        {...baseProps}
        gasTankPreflight={{
          status: "ready",
          address: "gas-tank-address",
          balanceSol: "0.2"
        }}
      />
    );

    expect(html).toContain("current balance is 0.2 SOL");
    expect(html).toContain("conservative rent allowance and network-fee buffer");
    expect(html).toContain("Gas Tank address:");
    expect(html).toContain("gas-tank-address");
  });
});
