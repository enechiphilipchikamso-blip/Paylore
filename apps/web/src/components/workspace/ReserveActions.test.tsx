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
  gasTankAllowsReserveInitialization,
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

describe("ReserveActions Gas Tank preflight", () => {
  it("blocks initialization until the Gas Tank exists and its live balance is verifiable", () => {
    expect(gasTankAllowsReserveInitialization("not_initialized")).toBe(false);
    expect(gasTankAllowsReserveInitialization("unavailable")).toBe(false);
    expect(gasTankAllowsReserveInitialization("ready")).toBe(true);
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

    expect(html).toContain("Gas Tank setup comes first");
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

    expect(html).toContain("could not verify the Gas Tank's live SOL balance");
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
    expect(html).toContain("exact fees and rent");
    expect(html).toContain("Gas Tank address:");
    expect(html).toContain("gas-tank-address");
  });
});
