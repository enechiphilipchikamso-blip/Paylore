import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => {
  const state: {
    stored: any;
    getWorkspaceReserve: ReturnType<typeof vi.fn>;
    createWorkspaceReserve: ReturnType<typeof vi.fn>;
    restoreWorkspaceReserve: ReturnType<typeof vi.fn>;
  } = {
    stored: null,
    getWorkspaceReserve: vi.fn(),
    createWorkspaceReserve: vi.fn(),
    restoreWorkspaceReserve: vi.fn()
  };
  state.getWorkspaceReserve.mockImplementation(async (_db: unknown, workspaceId: string) =>
    state.stored?.workspaceId === workspaceId ? state.stored : null
  );
  state.createWorkspaceReserve.mockImplementation(async (_db: unknown, input: Record<string, unknown>) => {
    if (state.stored?.workspaceId === input.workspaceId) return { reserve: state.stored, created: false };
    state.stored = {
      ...input,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      confidentialAccountSetupSignature: null,
      programReserveSetupSignature: null
    };
    return { reserve: state.stored, created: true };
  });
  state.restoreWorkspaceReserve.mockImplementation(async (
    _db: unknown, workspaceId: string, fields: Record<string, unknown>, now = new Date()
  ) => {
    if (state.stored?.workspaceId !== workspaceId) return null;
    state.stored = { ...state.stored, ...fields, updatedAt: now };
    return { workspaceId, address: state.stored.address };
  });
  return state;
});

vi.mock("server-only", () => ({}));
vi.mock("@paylore/database", () => ({
  getWorkspaceReserve: h.getWorkspaceReserve,
  createWorkspaceReserve: h.createWorkspaceReserve,
  restoreWorkspaceReserve: h.restoreWorkspaceReserve
}));
vi.mock("./config", () => ({
  loadPayloreConfig: () => ({
    PAYLORE_RESERVE_ENVELOPE_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA="
  })
}));

import {
  initializeWorkspaceReserve,
  verifyAndRestoreWorkspaceReserve,
  withWorkspaceReserveKey
} from "./reserve";
import {
  generateReserveKeypair,
  openReserveKey,
  sealReserveKey
} from "./reserve-crypto-policy";

const workspaceId = "workspace-a";
const envelopeKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

function storedReserve() {
  const keypair = generateReserveKeypair();
  const sealed = sealReserveKey(workspaceId, keypair.address, keypair.privateKey, envelopeKey);
  const row = {
    workspaceId,
    ...sealed,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    confidentialAccountSetupSignature: "setup-signature",
    programReserveSetupSignature: "program-signature"
  };
  keypair.privateKey.fill(0);
  return row;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.stored = null;
});

describe("workspace reserve key custody", () => {
  it("creates encrypted custody and returns only the public signing identity", async () => {
    const result = await initializeWorkspaceReserve({} as never, workspaceId);
    expect(result).toMatchObject({ created: true });
    expect(typeof result.address).toBe("string");
    expect(h.createWorkspaceReserve).toHaveBeenCalledOnce();
    expect(h.stored).not.toHaveProperty("privateKey");
    expect(h.stored).toHaveProperty("encryptedPrivateKey");
    expect(h.stored).toHaveProperty("encryptedBackup");
    expect(JSON.stringify(result)).not.toMatch(/privateKey|encrypted|backup|envelope/i);
    const opened = openReserveKey(workspaceId, h.stored, envelopeKey);
    try {
      expect(opened.length).toBe(64);
    } finally {
      opened.fill(0);
    }
  });

  it("is idempotent when a reserve already exists and never replaces its identity", async () => {
    const row = storedReserve();
    h.stored = row;
    const first = await initializeWorkspaceReserve({} as never, workspaceId);
    const second = await initializeWorkspaceReserve({} as never, workspaceId);
    expect(first.address).toBe(row.address);
    expect(second.address).toBe(row.address);
    expect(first.created).toBe(false);
    expect(second.created).toBe(false);
    expect(h.stored.address).toBe(row.address);
    expect(h.createWorkspaceReserve).toHaveBeenCalledTimes(2);
  });

  it("restores a corrupted primary envelope and verifies the persisted recovery key", async () => {
    const keypair = generateReserveKeypair();
    const expectedPrivateKey = Buffer.from(keypair.privateKey);
    const sealed = sealReserveKey(workspaceId, keypair.address, keypair.privateKey, envelopeKey);
    keypair.privateKey.fill(0);
    h.stored = {
      workspaceId,
      ...sealed,
      encryptedPrivateKey: Buffer.from("corrupt-primary-envelope").toString("base64"),
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
      confidentialAccountSetupSignature: "setup-signature",
      programReserveSetupSignature: "program-signature"
    };

    try {
      const result = await verifyAndRestoreWorkspaceReserve({} as never, workspaceId);
      expect(result.address).toBe(sealed.address);
      expect(h.restoreWorkspaceReserve).toHaveBeenCalledOnce();
      expect(h.stored.confidentialAccountSetupSignature).toBe("setup-signature");
      expect(h.stored.programReserveSetupSignature).toBe("program-signature");
      let borrowedKey: Uint8Array | undefined;
      const outcome = await withWorkspaceReserveKey({} as never, workspaceId, async (privateKey) => {
        borrowedKey = privateKey;
        expect(Buffer.from(privateKey)).toEqual(expectedPrivateKey);
        return "key-used-without-returning-secret";
      });
      expect(outcome).toBe("key-used-without-returning-secret");
      expect(borrowedKey?.every((value) => value === 0)).toBe(true);
    } finally {
      expectedPrivateKey.fill(0);
    }
  });

  it("fails if the repository reports a different identity during restore", async () => {
    h.stored = storedReserve();
    h.restoreWorkspaceReserve.mockImplementationOnce(async () => ({
      workspaceId, address: "different-reserve-address"
    }));
    await expect(verifyAndRestoreWorkspaceReserve({} as never, workspaceId))
      .rejects.toThrow("could not be restored");
  });

  it("does not initialize a missing reserve during restore", async () => {
    await expect(verifyAndRestoreWorkspaceReserve({} as never, workspaceId))
      .rejects.toThrow("not initialized");
    expect(h.createWorkspaceReserve).not.toHaveBeenCalled();
    expect(h.restoreWorkspaceReserve).not.toHaveBeenCalled();
  });
});
