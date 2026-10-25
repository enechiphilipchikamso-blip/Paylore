import { expect, test } from "@playwright/test";

test.describe("confidential reserve access boundary", () => {
  const workspaceId = "00000000-0000-4000-8000-000000000001";

  test("reserve read and restore do not disclose state or key material to unauthenticated callers", async ({ request }) => {
    const url = `/api/workspaces/${workspaceId}/settings/reserve`;
    const read = await request.get(url);
    expect(read.status()).toBe(401);
    const readBody = await read.json();
    expect(readBody).toEqual({ error: "authentication_required" });
    expect(JSON.stringify(readBody)).not.toMatch(/privateKey|encryptedPrivateKey|envelopeKey|sessionToken|secret/i);

    const restore = await request.post(url, {
      headers: { origin: "http://localhost:3100", "content-type": "application/json" },
      data: { action: "restore" }
    });
    expect(restore.status()).toBe(401);
    const restoreBody = await restore.json();
    expect(restoreBody).toEqual({ error: "authentication_required" });
    expect(JSON.stringify(restoreBody)).not.toMatch(/privateKey|encryptedPrivateKey|envelopeKey|sessionToken|secret/i);
  });
});
