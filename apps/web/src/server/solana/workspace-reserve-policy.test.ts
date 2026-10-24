import { describe, expect, it } from "vitest";
import { address, getAddressEncoder } from "@solana/kit";
import { createHash } from "node:crypto";
import {
  hasApprovedConfidentialTransferAccount,
  verifyWorkspaceProgramState
} from "./workspace-reserve-policy";

const programId = "4zYM9ZjwbAz9jxQ2C69Z83n1s4wceCPk7VzDLKoUnT93";
const authorityAddress = "11111111111111111111111111111111";
const workspaceId = "workspace-123";
const workspaceSeed = new Uint8Array(createHash("sha256").update("paylore:workspace:v1:" + workspaceId).digest());

function workspaceAccount(overrides: {
  owner?: string; authority?: string; id?: string; seed?: Uint8Array; bump?: number; executable?: boolean;
} = {}) {
  const id = new TextEncoder().encode(overrides.id ?? workspaceId);
  const seed = overrides.seed ?? workspaceSeed;
  const bytes = new Uint8Array(141);
  bytes.set(new Uint8Array(createHash("sha256").update("account:WorkspaceState").digest()).slice(0, 8), 0);
  bytes.set(getAddressEncoder().encode(address(overrides.authority ?? authorityAddress)), 8);
  new DataView(bytes.buffer).setUint32(40, id.length, true);
  bytes.set(id, 44);
  bytes.set(seed, 44 + id.length);
  bytes[44 + id.length + 32] = overrides.bump ?? 255;
  return {
    owner: overrides.owner ?? programId,
    executable: overrides.executable ?? false,
    data: [Buffer.from(bytes).toString("base64"), "base64"] as const
  };
}

describe("workspace reserve program account identity", () => {
  it("recognizes a missing workspace account without pretending the program state exists", () => {
    expect(verifyWorkspaceProgramState({
      account: null, programId, authorityAddress, workspaceId, workspaceSeed, expectedBump: 255
    })).toEqual({ status: "workspace_program_not_initialized" });
  });

  it("requires the exact initialized authority, workspace seed, program owner, and PDA bump", () => {
    expect(verifyWorkspaceProgramState({
      account: workspaceAccount(), programId, authorityAddress, workspaceId, workspaceSeed, expectedBump: 255
    })).toEqual({ status: "workspace_verified" });
    expect(() => verifyWorkspaceProgramState({
      account: workspaceAccount({ authority: "Vote111111111111111111111111111111111111111" }),
      programId, authorityAddress, workspaceId, workspaceSeed, expectedBump: 255
    })).toThrow(/does not match/);
    expect(() => verifyWorkspaceProgramState({
      account: workspaceAccount({ seed: new Uint8Array(32).fill(4) }),
      programId, authorityAddress, workspaceId, workspaceSeed, expectedBump: 255
    })).toThrow(/does not match/);
    expect(() => verifyWorkspaceProgramState({
      account: workspaceAccount({ bump: 254 }),
      programId, authorityAddress, workspaceId, workspaceSeed, expectedBump: 255
    })).toThrow(/does not match/);
    expect(() => verifyWorkspaceProgramState({
      account: workspaceAccount({ owner: authorityAddress }),
      programId, authorityAddress, workspaceId, workspaceSeed, expectedBump: 255
    })).toThrow(/identity is invalid/);
  });

  it("accepts only approved, owner-correct confidential accounts", () => {
    const token = {
      owner: authorityAddress,
      mint: "WrappedMint",
      extensions: [{
        __kind: "ConfidentialTransferAccount",
        approved: true,
        allowConfidentialCredits: true
      }]
    };
    expect(hasApprovedConfidentialTransferAccount(token, {
      owner: authorityAddress, mint: "WrappedMint"
    })).toBe(true);
    expect(hasApprovedConfidentialTransferAccount({
      ...token,
      extensions: [{ __kind: "ConfidentialTransferAccount", approved: false, allowConfidentialCredits: true }]
    }, { owner: authorityAddress, mint: "WrappedMint" })).toBe(false);
    expect(hasApprovedConfidentialTransferAccount(token, {
      owner: "OtherWallet", mint: "WrappedMint"
    })).toBe(false);
  });
});
