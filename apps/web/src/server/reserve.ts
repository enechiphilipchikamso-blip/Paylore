import "server-only";

import {
  createWorkspaceReserve,
  getWorkspaceReserve,
  restoreWorkspaceReserve,
  type Database
} from "@paylore/database";
import { loadPayloreConfig } from "./config";
import {
  generateReserveKeypair,
  openReserveKey,
  restoreReserveFromBackup,
  sealReserveKey
} from "./reserve-crypto-policy";

function requireEnvelopeKey(): string {
  const key =
    loadPayloreConfig().PAYLORE_RESERVE_ENVELOPE_KEY;
  if (!key) {
    throw new Error(
      "Reserve envelope encryption is not configured."
    );
  }
  return key;
}

export async function initializeWorkspaceReserve(
  db: Database,
  workspaceId: string
) {
  const envelopeKey = requireEnvelopeKey();
  const existing =
    await getWorkspaceReserve(db, workspaceId);

  if (existing) {
    const key = openReserveKey(
      workspaceId,
      existing,
      envelopeKey
    );
    key.fill(0);
    return {
      address: existing.address,
      created: false
    };
  }

  const keypair = generateReserveKeypair();
  try {
    const sealed = sealReserveKey(
      workspaceId,
      keypair.address,
      keypair.privateKey,
      envelopeKey
    );
    const result = await createWorkspaceReserve(
      db,
      {
        workspaceId,
        ...sealed
      }
    );
    const verifiedKey = openReserveKey(
      workspaceId,
      result.reserve,
      envelopeKey
    );
    verifiedKey.fill(0);
    return {
      address: result.reserve.address,
      created: result.created
    };
  } finally {
    keypair.privateKey.fill(0);
  }
}

export async function verifyAndRestoreWorkspaceReserve(
  db: Database,
  workspaceId: string
) {
  const envelopeKey = requireEnvelopeKey();
  const existing =
    await getWorkspaceReserve(db, workspaceId);
  if (!existing) {
    throw new Error("The workspace reserve is not initialized.");
  }

  const restored = restoreReserveFromBackup(
    workspaceId,
    existing,
    envelopeKey
  );
  const privateKey = openReserveKey(
    workspaceId,
    restored,
    envelopeKey
  );
  privateKey.fill(0);

  const result = await restoreWorkspaceReserve(
    db,
    workspaceId,
    restored
  );
  if (!result) {
    throw new Error(
      "The verified reserve backup could not be restored."
    );
  }
  return {
    address: result.address,
    restoredAt: new Date()
  };
}

export async function withWorkspaceReserveKey<T>(
  db: Database,
  workspaceId: string,
  operation: (privateKey: Uint8Array) => Promise<T>
): Promise<T> {
  const existing =
    await getWorkspaceReserve(db, workspaceId);
  if (!existing) {
    throw new Error("The workspace reserve is not initialized.");
  }

  const privateKey = openReserveKey(
    workspaceId,
    existing,
    requireEnvelopeKey()
  );
  try {
    return await operation(privateKey);
  } finally {
    privateKey.fill(0);
  }
}
