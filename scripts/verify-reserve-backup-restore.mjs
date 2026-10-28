import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const FUNDING_STATES = new Set([
  "public_funds_available",
  "pending_confidential_balance",
  "confidential_funds_available"
]);
const BALANCE_KEYS = ["publicBalanceBaseUnits", "availableBalanceBaseUnits", "pendingBalanceBaseUnits"];
const PRIVATE_RESPONSE_KEY = /^(?:privatekey|encryptedprivatekey|privatekeynonce|privatekeyauthtag|envelopekey|encrypteddatakey|datakey|datakeynonce|datakeyauthtag|encryptedbackup|backupnonce|backupauthtag|secret|sessiontoken|cookie)$/i;

function assertNoSecretFields(value) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_RESPONSE_KEY.test(key.replace(/[^a-z]/gi, ""))) {
      throw new Error("The reserve API returned an internal key or credential field.");
    }
    assertNoSecretFields(child);
  }
}

function readSnapshot(payload, label) {
  assertNoSecretFields(payload);
  const reserve = payload?.reserve;
  const state = payload?.onChainAccount;
  if (!reserve || typeof reserve.address !== "string" || !state ||
      state.status !== "program_configured" || state.programReserveConfigured !== true ||
      state.confidentialTransferReady !== true || state.reserveAddress !== reserve.address ||
      typeof state.tokenAccount !== "string" || !FUNDING_STATES.has(state.fundingState)) {
    throw new Error(`The ${label} reserve is not fully initialized, confidential-ready, and funded.`);
  }
  const balances = {};
  for (const key of BALANCE_KEYS) {
    if (typeof state[key] !== "string" || !/^(0|[1-9][0-9]*)$/.test(state[key])) {
      throw new Error(`The ${label} reserve has invalid finalized balance evidence.`);
    }
    balances[key] = BigInt(state[key]);
  }
  const expectedFundingState = balances.availableBalanceBaseUnits > 0n
    ? "confidential_funds_available"
    : balances.pendingBalanceBaseUnits > 0n
      ? "pending_confidential_balance"
      : balances.publicBalanceBaseUnits > 0n
        ? "public_funds_available"
        : "unfunded";
  if (state.fundingState !== expectedFundingState || expectedFundingState === "unfunded") {
    throw new Error(`The ${label} reserve funding state does not match finalized balances.`);
  }
  return {
    reserveAddress: reserve.address,
    state: state.status,
    reserveStateConfigured: state.programReserveConfigured,
    tokenAccount: state.tokenAccount,
    confidentialTransferReady: state.confidentialTransferReady,
    fundingState: state.fundingState,
    balances: Object.fromEntries(Object.entries(balances).map(([key, amount]) => [key, amount.toString()]))
  };
}

async function requestJson(fetchImpl, url, origin, cookie, method, body) {
  const response = await fetchImpl(url, {
    method,
    headers: { Origin: origin, Cookie: cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    cache: "no-store",
    redirect: "error"
  });
  if (!response.ok) throw new Error(`reserve_${method.toLowerCase()}_http_${response.status}`);
  let payload;
  try { payload = await response.json(); } catch { throw new Error("reserve_api_invalid_json"); }
  assertNoSecretFields(payload);
  return payload;
}

/** Verifies backup restore preserves finalized reserve identity, readiness, and balances. */
export async function verifyReserveBackupRestore({ baseUrl, workspaceId, cookie, fetchImpl = fetch }) {
  if (typeof baseUrl !== "string" || typeof workspaceId !== "string" ||
      workspaceId.trim() === "" || typeof cookie !== "string" || cookie.trim() === "") {
    throw new Error("Set PAYLORE_RESERVE_ACCEPTANCE_BASE_URL, PAYLORE_RESERVE_ACCEPTANCE_WORKSPACE_ID, and PAYLORE_RESERVE_ACCEPTANCE_COOKIE.");
  }
  const base = new URL(baseUrl);
  if (base.protocol !== "https:" && !(base.protocol === "http:" && ["localhost", "127.0.0.1"].includes(base.hostname))) {
    throw new Error("The reserve acceptance base URL must use HTTPS except on localhost.");
  }
  const url = new URL(`/api/workspaces/${encodeURIComponent(workspaceId)}/settings/reserve`, base);
  const before = readSnapshot(await requestJson(fetchImpl, url, base.origin, cookie, "GET"), "pre-restore");
  const restored = await requestJson(fetchImpl, url, base.origin, cookie, "POST", { action: "restore" });
  if (restored?.status !== "key_custody_configured" || restored.address !== before.reserveAddress ||
      typeof restored.restoredAt !== "string" || !Number.isFinite(Date.parse(restored.restoredAt))) {
    throw new Error("reserve_restore_did_not_confirm_same_key_identity");
  }
  const after = readSnapshot(await requestJson(fetchImpl, url, base.origin, cookie, "GET"), "post-restore");
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("reserve_identity_readiness_or_finalized_balances_changed_after_restore");
  }
  return { reserveAddress: after.reserveAddress, tokenAccount: after.tokenAccount, fundingState: after.fundingState };
}

async function main() {
  const result = await verifyReserveBackupRestore({
    baseUrl: process.env.PAYLORE_RESERVE_ACCEPTANCE_BASE_URL,
    workspaceId: process.env.PAYLORE_RESERVE_ACCEPTANCE_WORKSPACE_ID,
    cookie: process.env.PAYLORE_RESERVE_ACCEPTANCE_COOKIE
  });
  process.stdout.write(`Reserve backup/restore acceptance verified for ${result.reserveAddress}: identity, readiness, funding state, and finalized balances were unchanged.\n`);
}
if (resolve(process.argv[1] ?? "") === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`Reserve backup/restore acceptance failed: ${error instanceof Error ? error.message : "unknown_error"}\n`);
    process.exitCode = 1;
  });
}
