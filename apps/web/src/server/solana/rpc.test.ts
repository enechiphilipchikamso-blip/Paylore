import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { getDevnetHealth } from "./rpc";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Solana Devnet RPC failover", () => {
  it("uses the configured secondary provider when the primary rejects getSlot", async () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("PAYLORE_NETWORK", "devnet");
    vi.stubEnv("PAYLORE_RPC_PRIMARY_PROVIDER", "helius");
    vi.stubEnv(
      "PAYLORE_RPC_PRIMARY_URL",
      "https://devnet.helius-rpc.example/"
    );
    vi.stubEnv("PAYLORE_RPC_PRIMARY_API_KEY", "");
    vi.stubEnv("PAYLORE_RPC_SECONDARY_PROVIDER", "quicknode");
    vi.stubEnv(
      "PAYLORE_RPC_SECONDARY_URL",
      "https://devnet.quicknode.example/"
    );
    vi.stubEnv("PAYLORE_RPC_SECONDARY_API_KEY", "");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ result: 123_456 }), {
          headers: { "content-type": "application/json" }
        })
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(getDevnetHealth()).resolves.toEqual({
      network: "devnet",
      slot: 123_456
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      "https://devnet.helius-rpc.example/"
    );
    expect(String(fetchMock.mock.calls[1][0])).toBe(
      "https://devnet.quicknode.example/"
    );
  });
});
