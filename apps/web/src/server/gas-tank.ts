import "server-only";

import {
  createWorkspaceGasTank,
  createWorkspaceLedgerEntry,
  createWorkspaceNotificationForFinanceMembers,
  getWorkspaceGasTank,
  restoreWorkspaceGasTank,
  updateWorkspaceGasTankBalance,
  type Database
} from "@paylore/database";
import { loadPayloreConfig } from "./config";
import {
  generateReserveKeypair,
  openGasTankKey,
  restoreGasTankFromBackup,
  sealGasTankKey
} from "./reserve-crypto-policy";
import { readSolanaRpc } from "./solana/rpc";
import { inspectGasTankFundingTransaction } from "./gas-tank-policy";

function requireGasTankEnvelopeKey(): string {
  const key = loadPayloreConfig().PAYLORE_GAS_TANK_ENVELOPE_KEY;
  if (!key) {
    throw new Error("Gas Tank envelope encryption is not configured.");
  }
  return key;
}

export async function initializeWorkspaceGasTank(
  db: Database,
  workspaceId: string
) {
  const envelopeKey = requireGasTankEnvelopeKey();
  const existing = await getWorkspaceGasTank(db, workspaceId);
  if (existing) {
    const privateKey = openGasTankKey(workspaceId, existing, envelopeKey);
    privateKey.fill(0);
    return { address: existing.address, created: false };
  }

  const keypair = generateReserveKeypair();
  try {
    const sealed = sealGasTankKey(
      workspaceId,
      keypair.address,
      keypair.privateKey,
      envelopeKey
    );
    const result = await createWorkspaceGasTank(db, {
      workspaceId,
      ...sealed
    });
    const verificationKey = openGasTankKey(
      workspaceId,
      result.gasTank,
      envelopeKey
    );
    verificationKey.fill(0);
    return {
      address: result.gasTank.address,
      created: result.created
    };
  } finally {
    keypair.privateKey.fill(0);
  }
}

export async function getWorkspaceGasTankSnapshot(
  db: Database,
  workspaceId: string
) {
  const gasTank = await getWorkspaceGasTank(db, workspaceId);
  if (!gasTank) return null;

  const result = await readSolanaRpc<{
    value: number;
  }>("getBalance", [
    gasTank.address,
    { commitment: "confirmed" }
  ]);
  if (!Number.isSafeInteger(result.value) || result.value < 0) {
    throw new Error("The Solana provider returned an invalid balance.");
  }

  const latest =
    String(result.value) === gasTank.balanceLamports
      ? gasTank
      : await updateWorkspaceGasTankBalance(
          db,
          workspaceId,
          String(result.value)
        );
  if (!latest) {
    throw new Error("The Gas Tank state could not be refreshed.");
  }

  return {
    address: latest.address,
    balanceLamports: latest.balanceLamports,
    lowBalance: BigInt(latest.balanceLamports) < 50_000_000n,
    lastActivityAt: latest.lastActivityAt,
    updatedAt: latest.updatedAt
  };
}

export async function verifyAndRestoreWorkspaceGasTank(
  db: Database,
  workspaceId: string
) {
  const existing = await getWorkspaceGasTank(db, workspaceId);
  if (!existing) {
    throw new Error("The workspace Gas Tank is not initialized.");
  }
  const envelopeKey = requireGasTankEnvelopeKey();
  const restored = restoreGasTankFromBackup(
    workspaceId,
    existing,
    envelopeKey
  );
  const privateKey = openGasTankKey(
    workspaceId,
    restored,
    envelopeKey
  );
  privateKey.fill(0);

  const result = await restoreWorkspaceGasTank(
    db,
    workspaceId,
    restored
  );
  if (!result) {
    throw new Error("The verified Gas Tank backup could not be restored.");
  }
  return {
    address: result.address,
    restoredAt: new Date()
  };
}

export async function withWorkspaceGasTankKey<T>(
  db: Database,
  workspaceId: string,
  operation: (privateKey: Uint8Array) => Promise<T>
): Promise<T> {
  const gasTank = await getWorkspaceGasTank(db, workspaceId);
  if (!gasTank) {
    throw new Error("The workspace Gas Tank is not initialized.");
  }
  const privateKey = openGasTankKey(
    workspaceId,
    gasTank,
    requireGasTankEnvelopeKey()
  );
  try {
    return await operation(privateKey);
  } finally {
    privateKey.fill(0);
  }
}

export async function verifyWorkspaceGasTankFunding(
  db: Database,
  input: {
    workspaceId: string;
    payer: string;
    signature: string;
    expectedLamports: string;
  }
) {
  const gasTank = await getWorkspaceGasTank(db, input.workspaceId);
  if (!gasTank) {
    return { status: "invalid" as const };
  }

  const transaction = await readSolanaRpc<{
    transaction?: unknown;
    meta?: unknown;
  } | null>("getTransaction", [
    input.signature,
    {
      commitment: "finalized",
      encoding: "jsonParsed",
      maxSupportedTransactionVersion: 0
    }
  ]);
  const inspected = inspectGasTankFundingTransaction(transaction, {
    payer: input.payer,
    destination: gasTank.address
  });
  if (inspected.status === "pending") return inspected;
  if (
    inspected.status === "invalid" ||
    inspected.lamports !== input.expectedLamports
  ) {
    return { status: "invalid" as const };
  }

  const statuses = await readSolanaRpc<{
    value: Array<{
      confirmationStatus: string | null;
      err: unknown;
    } | null>;
  }>("getSignatureStatuses", [
    [input.signature],
    { searchTransactionHistory: true }
  ]);
  const status = statuses.value[0];
  if (!status || status.confirmationStatus !== "finalized") {
    return { status: "pending" as const };
  }
  if (status.err !== null) {
    return { status: "invalid" as const };
  }

  const ledger = await createWorkspaceLedgerEntry(db, {
    workspaceId: input.workspaceId,
    idempotencyKey: `gas-tank-funding:${input.signature}`,
    category: "gas_operations",
    entryType: "gas_tank_funding",
    status: "finalized",
    amountBaseUnits: inspected.lamports,
    referenceType: "gas_tank",
    referenceId: input.workspaceId,
    transactionSignature: input.signature,
    metadata: { asset: "SOL" }
  });
  await createWorkspaceNotificationForFinanceMembers(db, {
    workspaceId: input.workspaceId,
    eventKey: `gas-tank-funding:${input.signature}`,
    category: "gas_operations",
    title: "Gas Tank funded",
    body: "A finalized manual funding transaction was recorded for this workspace Gas Tank.",
    destination: `/workspace/${input.workspaceId}/gas-tank`
  });
  await updateWorkspaceGasTankBalance(
    db,
    input.workspaceId,
    gasTank.balanceLamports
  );
  return {
    status: "finalized" as const,
    duplicate: !ledger.created
  };
}
