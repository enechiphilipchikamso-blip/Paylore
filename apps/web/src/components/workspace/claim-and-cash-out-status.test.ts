import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { getClaimAndCashOutOutcome } from "./claim-and-cash-out-outcome";
import { ClaimAndCashOutStatus } from "./claim-and-cash-out-status";

function renderOutcome(input: Parameters<typeof getClaimAndCashOutOutcome>[0]): string {
  return renderToStaticMarkup(createElement(ClaimAndCashOutStatus, {
    message: getClaimAndCashOutOutcome(input)
  }));
}

describe("rendered Claim & Cash Out outcome status", () => {
  it("renders finalized full success as a status, not an alert", () => {
    const markup = renderOutcome({
      settled: 2, pending: 0, failed: 0, cleanupPending: 0, stateConflict: false
    });

    expect(markup).toContain('data-state="success"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain('data-testid="claim-and-cash-out-outcome"');
    expect(markup).toContain("2 confidential payroll allocation(s) transferred and reconciled.");
    expect(markup).not.toContain("await finality or retry");
  });

  it("renders pending finality as partial and never as success", () => {
    const markup = renderOutcome({
      settled: 0, pending: 1, failed: 0, cleanupPending: 0, stateConflict: false
    });

    expect(markup).toContain('data-state="partial"');
    expect(markup).toContain('role="status"');
    expect(markup).toContain("1 await finality or retry");
    expect(markup).not.toContain('data-state="success"');
  });

  it("renders safe retry as partial without implying payment completed", () => {
    const markup = renderOutcome({
      settled: 0, pending: 1, failed: 0, cleanupPending: 0, stateConflict: false
    });

    expect(markup).toContain('data-state="partial"');
    expect(markup).toContain("0 allocation(s) settled");
  });

  it("renders successful transfer with cleanup still required as partial", () => {
    const markup = renderOutcome({
      settled: 1, pending: 0, failed: 0, cleanupPending: 1, stateConflict: false
    });

    expect(markup).toContain('data-state="partial"');
    expect(markup).toContain("1 need proof-context cleanup");
    expect(markup).not.toContain('data-state="success"');
  });

  it("renders request failure as an alert and does not overstate success", () => {
    const markup = renderOutcome({
      settled: 0, pending: 0, failed: 1, cleanupPending: 0, stateConflict: false
    });

    expect(markup).toContain('data-state="error"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("1 need attention.");
    expect(markup).not.toContain("transferred and reconciled");
  });

  it("renders Claim PDA conflict as an actionable alert", () => {
    const markup = renderOutcome({
      settled: 0, pending: 0, failed: 0, cleanupPending: 0, stateConflict: true
    });

    expect(markup).toContain('data-state="error"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("No second transfer was attempted");
    expect(markup).toContain("administrator reconciliation before retry");
  });

  it("renders partial completion distinctly from both success and error", () => {
    const markup = renderOutcome({
      settled: 1, pending: 0, failed: 1, cleanupPending: 0, stateConflict: false
    });

    expect(markup).toContain('data-state="partial"');
    expect(markup).toContain("1 allocation(s) settled; 1 need attention.");
  });

  it("renders no status surface before an outcome exists", () => {
    const markup = renderToStaticMarkup(createElement(ClaimAndCashOutStatus, { message: null }));
    expect(markup).toBe("");
  });
});
