import { describe, expect, it } from "vitest";
import {
  walletConnectionHomeLabel,
  walletDisconnectedToastMessage
} from "./wallet-connection-copy";

describe("wallet connection copy", () => {
  it("names the administrator workspace home for administrators", () => {
    expect(walletDisconnectedToastMessage("organization_admin")).toBe(
      "Go to your administrator workspace home and reconnect your wallet to continue."
    );
  });

  it("names the contributor dashboard home for contributors", () => {
    expect(walletDisconnectedToastMessage("contributor")).toBe(
      "Go to your contributor dashboard home and reconnect your wallet to continue."
    );
  });

  it("names the auditor dashboard home for finance auditors", () => {
    expect(walletDisconnectedToastMessage("finance_auditor")).toBe(
      "Go to your auditor dashboard home and reconnect your wallet to continue."
    );
  });

  it("never mentions another role's home", () => {
    expect(walletConnectionHomeLabel("contributor")).not.toMatch(/administrator|auditor/);
    expect(walletConnectionHomeLabel("finance_auditor")).not.toMatch(/administrator|contributor/);
    expect(walletConnectionHomeLabel("organization_admin")).not.toMatch(/contributor|auditor/);
  });
});
