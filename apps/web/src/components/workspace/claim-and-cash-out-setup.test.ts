import { describe, expect, it, vi } from "vitest";
import { ensureClaimAndCashOutAccount } from "./claim-and-cash-out-setup";

describe("Claim & Cash Out confidential-account setup gate", () => {
  it("starts company-sponsored setup on demand when the contributor has no ready account", async () => {
    const setupAccount = vi.fn().mockResolvedValue(true);

    await expect(ensureClaimAndCashOutAccount({
      accountReady: false,
      setupAccount
    })).resolves.toBe("account_setup_completed");

    expect(setupAccount).toHaveBeenCalledOnce();
  });

  it("does not initialize a second account when the contributor account is already ready", async () => {
    const setupAccount = vi.fn().mockResolvedValue(true);

    await expect(ensureClaimAndCashOutAccount({
      accountReady: true,
      setupAccount
    })).resolves.toBe("settlement_unavailable");

    expect(setupAccount).not.toHaveBeenCalled();
  });

  it("preserves the setup failure state instead of advancing toward a claim", async () => {
    const setupAccount = vi.fn().mockResolvedValue(false);

    await expect(ensureClaimAndCashOutAccount({
      accountReady: false,
      setupAccount
    })).resolves.toBe("account_setup_incomplete");
  });
});
