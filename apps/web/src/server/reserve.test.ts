import { beforeEach, describe, expect, it, vi } from "vitest";
import { generateReserveKeypair, sealReserveKey } from "./reserve-crypto-policy";

const mocks = vi.hoisted(() => ({
  envelopeKey: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  stored: null as Record<string, any> | null,
  createCalls: [] as Array<Record<string, any>>,
  restoreCalls: [] as Array<Record<string, any>>
}));
const FIXED_ENVELOPE_KEY = mocks.envelopeKey;

vi.mock("server-only", () => ({}));
vi.mock("./config", () => ({
  loadPayloreConfig: () => ({ PAYLORE_RESERVE_ENVELOPE_KEY: mocks.envelopeKey })
}));
vi.mock("@paylore/database", () => ({
  getWorkspaceReserve: vi.fn(async (_db: unknown, workspaceId: string) =>
    mocks.stored?.workspaceId === workspaceId ? mocks.stored : null
  ),
  createWorkspaceReserve: vi.fn(async (_db: unknown, input: Record<string, any>) => {
    mocks.createCalls.push(input);
    if (mocks.stored?.workspaceId === input.workspaceId) return { reserve: mocks.stored, created: false };
    const now = new Date("2026-10-25T00:00:00.000Z");
    mocks.stored = { ...input, createdAt: now, updatedAt: now };
    return { reserve: mocks.stored, created: true };
  }),
  restoreWorkspaceReserve: vi.fn(async (
    _db: unknown,
    workspaceId: string,
    sealedFields: Record<string, any>,
    now = new Date()
  ) => {
    if (mocks.stored?.workspaceId !== workspaceId) return null;
    mocks.restoreCalls.push({ workspaceId, sealedFields, now });
    mocks.stored = { ...mocks.stored, ...sealedFields, updatedAt: now };
    return { workspaceId, address: mocks.stored.address };
  })
}));

import { initializeWorkspaceReserve, verifyAndRestoreWorkspaceReserve, withWorkspaceReserveKey } from "./reserve";

function seedReserve(workspaceId = "workspace-a") {
  const keypair = generateReserveKeypair();
  const expectedPrivateKey = Buffer.from(keypair.privateKey);
  const sealed = sealReserveKey(workspaceId, keypair.address, keypair.privateKey, FIXED_ENVELOPE_KEY);
  keypair.privateKey.fill(0);
  const now = new Date("2026-10-24T00:00:00.000Z");
  const row = {
    workspaceId,
    ...sealed,
    createdAt: now,
    updatedAt: now,
    confidentialAccountSetupSignature: null,
    programReserveSetupSignature: null
  };
  mocks.stored = row;
  return { row, expectedPrivateKey };
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.envelopeKey = FIXED_ENVELOPE_KEY;
  mocks.stored = null;
  mocks.createCalls = [];
  mocks.restoreCalls = [];
});

describe("workspace reserve custody and recovery", () => {
  it("initializes encrypted custody without persisting or returning raw private-key material", async () => {
    const result = await initializeWorkspaceReserve({} as any, "workspace-a");

    expect(result).toMatchObject({ created: true });
    expect(result.address).toBe(mocks.stored?.address);
    expect(mocks.createCalls).toHaveLength(1);
    expect(mocks.createCalls[0]).not.toHaveProperty("privateKey");
    expect(mocks.createCalls[0]?.encryptedPrivateKey).toBeTruthy();
    expect(mocks.createCalls[0]?.encryptedBackup).toBeTruthy();

    const privateKey = await withWorkspaceReserveKey(
      {} as any, "workspace-a", async (key) => Buffer.from(key)
    );
    try {
      expect(privateKey).toHaveLength(64);
      expect(privateKey.subarray(32).length).toBe(32);
    } finally {
      privateKey.fill(0);
    }
  });

  it("reuses an existing verified reserve key without creating a second identity", async () => {
    const { row, expectedPrivateKey } = seedReserve();
    try {
      const result = await initializeWorkspaceReserve({} as any, "workspace-a");
      expect(result).toEqual({ address: row.address, created: false });
      expect(mocks.createCalls).toHaveLength(0);
      const opened = await withWorkspaceReserveKey(
        {} as any, "workspace-a", async (key) => Buffer.from(key)
      );
      try {
        expect(opened).toEqual(expectedPrivateKey);
      } finally {
        opened.fill(0);
      }
    } finally {
      expectedPrivateKey.fill(0);
    }
  });

  it("verifies the encrypted backup and persists a newly sealed copy of the same key", async () => {
    const { row, expectedPrivateKey } = seedReserve();
    const previousCiphertext = row.encryptedPrivateKey;
    try {
      const result = await verifyAndRestoreWorkspaceReserve({} as any, "workspace-a");
      expect(result.address).toBe(row.address);
      expect(result.restoredAt).toBeInstanceOf(Date);
      expect(mocks.restoreCalls).toHaveLength(1);
      expect(mocks.restoreCalls[0]?.workspaceId).toBe("workspace-a");
      expect(mocks.stored?.address).toBe(row.address);
      expect(mocks.stored?.encryptedPrivateKey).not.toBe(previousCiphertext);

      const restoredKey = await withWorkspaceReserveKey(
        {} as any, "workspace-a", async (key) => Buffer.from(key)
      );
      try {
        expect(restoredKey).toEqual(expectedPrivateKey);
      } finally {
        restoredKey.fill(0);
      }
    } finally {
      expectedPrivateKey.fill(0);
    }
  });

  it("does not overwrite valid custody when the backup fails authentication", async () => {
    const { row, expectedPrivateKey } = seedReserve();
    mocks.stored = { ...row, backupAuthTag: Buffer.alloc(16).toString("base64") };
    const before = mocks.stored.encryptedPrivateKey;
    try {
      await expect(verifyAndRestoreWorkspaceReserve({} as any, "workspace-a")).rejects.toThrow();
      expect(mocks.restoreCalls).toHaveLength(0);
      expect(mocks.stored?.encryptedPrivateKey).toBe(before);
    } finally {
      expectedPrivateKey.fill(0);
    }
  });

  it("rejects a workspace mismatch without changing another reserve", async () => {
    const { row, expectedPrivateKey } = seedReserve("workspace-a");
    try {
      await expect(verifyAndRestoreWorkspaceReserve({} as any, "workspace-b"))
        .rejects.toThrow("not initialized");
      expect(mocks.restoreCalls).toHaveLength(0);
      expect(mocks.stored?.workspaceId).toBe("workspace-a");
      expect(mocks.stored?.address).toBe(row.address);
    } finally {
      expectedPrivateKey.fill(0);
    }
  });

  it("requires configured envelope-key custody and zeroizes operation key buffers on success and failure", async () => {
    const { expectedPrivateKey } = seedReserve();
    try {
      mocks.envelopeKey = "";
      await expect(initializeWorkspaceReserve({} as any, "workspace-a"))
        .rejects.toThrow("Reserve envelope encryption is not configured.");
      mocks.envelopeKey = FIXED_ENVELOPE_KEY;

      let successBuffer: Uint8Array | undefined;
      await withWorkspaceReserveKey({} as any, "workspace-a", async (key) => {
        successBuffer = key;
        expect([...key]).toEqual([...expectedPrivateKey]);
        return "finished";
      });
      expect(successBuffer && [...successBuffer].every((byte) => byte === 0)).toBe(true);

      let failureBuffer: Uint8Array | undefined;
      await expect(withWorkspaceReserveKey({} as any, "workspace-a", async (key) => {
        failureBuffer = key;
        throw new Error("operation failed");
      })).rejects.toThrow("operation failed");
      expect(failureBuffer && [...failureBuffer].every((byte) => byte === 0)).toBe(true);
    } finally {
      expectedPrivateKey.fill(0);
    }
  });
});
