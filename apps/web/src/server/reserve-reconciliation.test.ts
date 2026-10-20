import { describe, expect, it, vi } from "vitest";
import {
  address,
  getAddressEncoder
} from "@solana/kit";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";

vi.mock("./config", () => ({
  loadPayloreConfig: () => ({
    PAYLORE_WRAPPED_USDC_MINT: "Vote111111111111111111111111111111111111111"
  })
}));
vi.mock("server-only", () => ({}));

import { verifyReserveTokenAccount } from "./reserve-reconciliation";

const expectedOwner = address("11111111111111111111111111111111");
const expectedMint = address("Vote111111111111111111111111111111111111111");

function accountData(
  owner: string = expectedOwner,
  mint: string = expectedMint
) {
  return Buffer.concat([
    Buffer.from(getAddressEncoder().encode(address(mint))),
    Buffer.from(getAddressEncoder().encode(address(owner))),
    Buffer.alloc(101)
  ]).toString("base64");
}

describe("reserve Token-2022 account identity reconciliation", () => {
  it("recognizes an existing token account only for the expected owner and mint", () => {
    expect(verifyReserveTokenAccount({
      account: {
        owner: TOKEN_2022_PROGRAM_ADDRESS,
        data: [accountData(), "base64"]
      },
      expectedOwner,
      expectedMint
    })).toBe("account_verified");
  });

  it("reports a missing token account without claiming reserve readiness", () => {
    expect(verifyReserveTokenAccount({
      account: null,
      expectedOwner,
      expectedMint
    })).toBe("account_missing");
  });

  it("rejects a token account with a different owner or mint", () => {
    expect(() => verifyReserveTokenAccount({
      account: {
        owner: TOKEN_2022_PROGRAM_ADDRESS,
        data: [accountData(address("Vote111111111111111111111111111111111111111")), "base64"]
      },
      expectedOwner,
      expectedMint
    })).toThrow("owner or mint");
    expect(() => verifyReserveTokenAccount({
      account: {
        owner: "11111111111111111111111111111111",
        data: [accountData(), "base64"]
      },
      expectedOwner,
      expectedMint
    })).toThrow("identity is invalid");
  });

  it("rejects malformed token account data", () => {
    expect(() => verifyReserveTokenAccount({
      account: {
        owner: TOKEN_2022_PROGRAM_ADDRESS,
        data: ["AA==", "base64"]
      },
      expectedOwner,
      expectedMint
    })).toThrow("data is malformed");
  });
});
