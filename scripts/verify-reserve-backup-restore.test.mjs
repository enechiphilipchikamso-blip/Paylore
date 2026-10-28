import test from "node:test";
import assert from "node:assert/strict";
import { verifyReserveBackupRestore } from "./verify-reserve-backup-restore.mjs";

const baseUrl = "https://paylore.example";
const workspaceId = "workspace-a";
const cookie = "session=must-never-be-logged";
const readyPayload = () => ({
  reserve: { address: "reserve-address" },
  onChainAccount: {
    status: "program_configured",
    reserveAddress: "reserve-address",
    tokenAccount: "reserve-token-account",
    confidentialTransferReady: true,
    programReserveConfigured: true,
    fundingState: "confidential_funds_available",
    publicBalanceBaseUnits: "0",
    availableBalanceBaseUnits: "1250000",
    pendingBalanceBaseUnits: "0"
  }
});

test("restore acceptance requires the same finalized reserve state before and after restore", async () => {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    calls.push(options);
    if (options.method === "GET") {
      const payload = readyPayload();
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    }
    return new Response(JSON.stringify({
      status: "key_custody_configured", address: "reserve-address", restoredAt: "2026-01-03T00:00:00.000Z"
    }), { status: 200, headers: { "content-type": "application/json" } });
  };
  assert.deepEqual(await verifyReserveBackupRestore({ baseUrl, workspaceId, cookie, fetchImpl }), {
    reserveAddress: "reserve-address", tokenAccount: "reserve-token-account", fundingState: "confidential_funds_available"
  });
  assert.equal(calls.length, 3);
  assert.equal(calls[0].headers.Cookie, cookie);
  assert.equal(calls[1].headers.Origin, baseUrl);
  assert.deepEqual(JSON.parse(calls[1].body), { action: "restore" });
});

test("rejects a configured but unfunded reserve", async () => {
  const payload = readyPayload();
  payload.onChainAccount.fundingState = "unfunded";
  payload.onChainAccount.availableBalanceBaseUnits = "0";
  const fetchImpl = async () => new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(verifyReserveBackupRestore({ baseUrl, workspaceId, cookie, fetchImpl }), /not fully initialized/);
});

test("rejects a restore result for another signing identity", async () => {
  let gets = 0;
  const fetchImpl = async (_url, options) => {
    if (options.method === "POST") return new Response(JSON.stringify({
      status: "key_custody_configured", address: "other-reserve", restoredAt: "2026-01-03T00:00:00.000Z"
    }), { status: 200, headers: { "content-type": "application/json" } });
    gets++;
    return new Response(JSON.stringify(readyPayload()), { status: 200, headers: { "content-type": "application/json" } });
  };
  await assert.rejects(verifyReserveBackupRestore({ baseUrl, workspaceId, cookie, fetchImpl }), /did_not_confirm_same_key_identity/);
  assert.equal(gets, 1);
});

test("rejects malformed balance evidence and secret-bearing responses", async () => {
  const invalidBalance = readyPayload();
  invalidBalance.onChainAccount.availableBalanceBaseUnits = "-1";
  const invalidFetch = async () => new Response(JSON.stringify(invalidBalance), { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(verifyReserveBackupRestore({ baseUrl, workspaceId, cookie, fetchImpl: invalidFetch }), /invalid finalized balance evidence/);
  const secretResponse = { ...readyPayload(), reserve: { ...readyPayload().reserve, encryptedPrivateKey: "not-allowed" } };
  const secretFetch = async () => new Response(JSON.stringify(secretResponse), { status: 200, headers: { "content-type": "application/json" } });
  await assert.rejects(verifyReserveBackupRestore({ baseUrl, workspaceId, cookie, fetchImpl: secretFetch }), /internal key or credential/);
});

test("requires HTTPS for remote acceptance targets", async () => {
  await assert.rejects(verifyReserveBackupRestore({ baseUrl: "http://paylore.example", workspaceId, cookie }), /must use HTTPS/);
});
