import { describe, expect, it } from "vitest";
import { AccountRole, address, getAddressEncoder } from "@solana/kit";
import {
  assertAllowedPayrollInstructionSet,
  classifyPreparedSponsorshipState,
  assertSimulationSucceeded,
  assertSponsoredClaimIntent,
  assertSponsoredCost,
  GasTankSponsorshipPolicyError,
  MAX_DAILY_SPONSORED_FEE_LAMPORTS,
  MAX_SPONSORED_FEE_LAMPORTS,
  MAX_CONFIDENTIAL_ACCOUNT_SETUP_RENT_LAMPORTS,
  assertAllowedConfidentialAccountSetupMessage
} from "./gas-tank-sponsorship-policy";

const programId = "payroll-program";
const authority = "manager-wallet";
const workspaceId = "workspace-a";
const workspace = "workspace-pda";
const system = "11111111111111111111111111111111";
const commitment = "ab".repeat(32);
const claim = {
  claimId: "01".repeat(32),
  contributorAddress: "contributor-wallet",
  claimAddress: "claim-pda"
};
const encoder = new TextEncoder();

function concat(...parts: Uint8Array[]) {
  const output = new Uint8Array(parts.reduce((sum, item) => sum + item.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function encodeString(value: string) {
  const bytes = encoder.encode(value);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, bytes.length, true);
  return concat(length, bytes);
}

function decodedHex(value: string) {
  return Uint8Array.from(value.match(/.{2}/g)!, (byte) => parseInt(byte, 16));
}

function instructions() {
  const initDiscriminator = new Uint8Array(8).fill(5);
  const createDiscriminator = new Uint8Array(8).fill(7);
  const workspaceSeed = new Uint8Array(32).fill(9);
  const accounts = (address: string, role: AccountRole) => ({ address, role });
  return {
    initDiscriminator,
    createDiscriminator,
    workspaceSeed,
    values: [
      {
        programAddress: programId,
        accounts: [
          accounts(authority, AccountRole.WRITABLE_SIGNER),
          accounts(workspace, AccountRole.WRITABLE),
          accounts(system, AccountRole.READONLY)
        ],
        data: concat(initDiscriminator, encodeString(workspaceId), workspaceSeed)
      },
      {
        programAddress: programId,
        accounts: [
          accounts(authority, AccountRole.WRITABLE_SIGNER),
          accounts(claim.contributorAddress, AccountRole.READONLY),
          accounts(workspace, AccountRole.READONLY),
          accounts(claim.claimAddress, AccountRole.WRITABLE),
          accounts(system, AccountRole.READONLY)
        ],
        data: concat(createDiscriminator, decodedHex(claim.claimId), decodedHex(commitment))
      }
    ]
  };
}

describe("Gas Tank sponsorship policy", () => {
  it("allows only a manager-authorized confirmed payroll claim intent", () => {
    expect(() => assertSponsoredClaimIntent({
      operation: "payroll_claim_commitment",
      workspaceId,
      requestedWorkspaceId: workspaceId,
      sessionWallet: authority,
      authorityAddress: authority,
      managerConfirmed: true,
      runCommitment: commitment,
      claims: [claim]
    })).not.toThrow();
  });

  it.each([
    { operation: "arbitrary_transaction" },
    { requestedWorkspaceId: "another-workspace" },
    { sessionWallet: "different-wallet" },
    { managerConfirmed: false },
    { runCommitment: null },
    { claims: [] },
    { claims: [claim, claim, claim, claim, claim] },
    { claims: [claim, { ...claim, claimId: claim.claimId.toUpperCase() }] }
  ])("rejects invalid sponsor intent: %o", (partial) => {
    expect(() => assertSponsoredClaimIntent({
      operation: "payroll_claim_commitment",
      workspaceId,
      requestedWorkspaceId: workspaceId,
      sessionWallet: authority,
      authorityAddress: authority,
      managerConfirmed: true,
      runCommitment: commitment,
      claims: [claim],
      ...partial
    })).toThrow(GasTankSponsorshipPolicyError);
  });

  it("allows only the exact server-built initialize and create-claim instructions", () => {
    const built = instructions();
    expect(() => assertAllowedPayrollInstructionSet({
      instructions: built.values,
      programId,
      authorityAddress: authority,
      workspaceId,
      workspaceAddress: workspace,
      allocationCommitment: commitment,
      workspaceSeed: built.workspaceSeed,
      claims: [claim],
      initializeDiscriminator: built.initDiscriminator,
      createClaimDiscriminator: built.createDiscriminator,
      systemProgramAddress: system
    })).not.toThrow();

    expect(() => assertAllowedPayrollInstructionSet({
      instructions: built.values.map((instruction, index) => index === 1
        ? { ...instruction, programAddress: "attacker-program" }
        : instruction),
      programId,
      authorityAddress: authority,
      workspaceId,
      workspaceAddress: workspace,
      allocationCommitment: commitment,
      workspaceSeed: built.workspaceSeed,
      claims: [claim],
      initializeDiscriminator: built.initDiscriminator,
      createClaimDiscriminator: built.createDiscriminator,
      systemProgramAddress: system
    })).toThrow("sponsored_claim_instruction_denied");

    expect(() => assertAllowedPayrollInstructionSet({
      instructions: built.values.map((instruction, index) => index === 1
        ? { ...instruction, accounts: [{ address: "attacker", role: AccountRole.WRITABLE_SIGNER }, ...instruction.accounts.slice(1)] }
        : instruction),
      programId,
      authorityAddress: authority,
      workspaceId,
      workspaceAddress: workspace,
      allocationCommitment: commitment,
      workspaceSeed: built.workspaceSeed,
      claims: [claim],
      initializeDiscriminator: built.initDiscriminator,
      createClaimDiscriminator: built.createDiscriminator,
      systemProgramAddress: system
    })).toThrow("sponsored_claim_instruction_denied");
  });

  it("rejects an authority account whose signer role was downgraded", () => {
    const built = instructions();
    const altered = built.values.map((instruction, index) => index === 1
      ? {
          ...instruction,
          accounts: [
            { address: authority, role: AccountRole.READONLY },
            ...instruction.accounts.slice(1)
          ]
        }
      : instruction);
    expect(() => assertAllowedPayrollInstructionSet({
      instructions: altered,
      programId,
      authorityAddress: authority,
      workspaceId,
      workspaceAddress: workspace,
      allocationCommitment: commitment,
      workspaceSeed: built.workspaceSeed,
      claims: [claim],
      initializeDiscriminator: built.initDiscriminator,
      createClaimDiscriminator: built.createDiscriminator,
      systemProgramAddress: system
    })).toThrow("sponsored_claim_instruction_denied");
  });

  it("rejects a payroll instruction that substitutes another signer address", () => {
    const built = instructions();
    const altered = built.values.map((instruction, index) => index === 1
      ? {
          ...instruction,
          accounts: [
            { address: "attacker-wallet", role: AccountRole.WRITABLE_SIGNER },
            ...instruction.accounts.slice(1)
          ]
        }
      : instruction);
    expect(() => assertAllowedPayrollInstructionSet({
      instructions: altered,
      programId,
      authorityAddress: authority,
      workspaceId,
      workspaceAddress: workspace,
      allocationCommitment: commitment,
      workspaceSeed: built.workspaceSeed,
      claims: [claim],
      initializeDiscriminator: built.initDiscriminator,
      createClaimDiscriminator: built.createDiscriminator,
      systemProgramAddress: system
    })).toThrow("sponsored_claim_instruction_denied");
  });

  it("validates claim-only sponsored batches when the workspace PDA already exists", () => {
    const built = instructions();
    const claimOnly = built.values.slice(1);
    expect(() => assertAllowedPayrollInstructionSet({
      instructions: claimOnly,
      programId,
      authorityAddress: authority,
      workspaceId,
      workspaceAddress: workspace,
      allocationCommitment: commitment,
      workspaceSeed: built.workspaceSeed,
      claims: [claim],
      initializeDiscriminator: built.initDiscriminator,
      createClaimDiscriminator: built.createDiscriminator,
      includeWorkspaceInitialization: false,
      systemProgramAddress: system
    })).not.toThrow();
  });

  it("denies excessive size, fees, insufficient balance and daily budget exhaustion", () => {
    expect(() => assertSponsoredCost({
      transactionBytes: 1233, feeLamports: 10_000n, balanceLamports: 1_000_000n,
      dailyBookedFeesLamports: 0n, dailyOperationCount: 0
    })).toThrow("sponsored_transaction_size_exceeded");
    expect(() => assertSponsoredCost({
      transactionBytes: 500, feeLamports: MAX_SPONSORED_FEE_LAMPORTS + 1n,
      balanceLamports: 1_000_000n, dailyBookedFeesLamports: 0n, dailyOperationCount: 0
    })).toThrow("sponsored_fee_limit_exceeded");
    expect(() => assertSponsoredCost({
      transactionBytes: 500, feeLamports: 20_000n, balanceLamports: 10_000n,
      dailyBookedFeesLamports: 0n, dailyOperationCount: 0
    })).toThrow("gas_tank_insufficient_balance");
    expect(() => assertSponsoredCost({
      transactionBytes: 500, feeLamports: MAX_SPONSORED_FEE_LAMPORTS,
      balanceLamports: 5_000_000n,
      dailyBookedFeesLamports: MAX_DAILY_SPONSORED_FEE_LAMPORTS,
      dailyOperationCount: 100
    })).toThrow("gas_tank_daily_sponsorship_limit");
  });

  it.each([
    { balanceLamports: -1n },
    { dailyBookedFeesLamports: -1n },
    { dailyOperationCount: -1 },
    { dailyOperationCount: 0.5 }
  ])("rejects invalid sponsorship budget evidence: %o", (partial) => {
    expect(() => assertSponsoredCost({
      transactionBytes: 500,
      feeLamports: 5_000n,
      balanceLamports: 1_000_000n,
      dailyBookedFeesLamports: 0n,
      dailyOperationCount: 0,
      ...partial
    })).toThrow("sponsored_budget_evidence_invalid");
  });

  it("releases sponsorship only when signature history is absent beyond blockhash expiry", () => {
    const base = { lastValidBlockHeight: 120 };
    expect(classifyPreparedSponsorshipState({ ...base, currentBlockHeight: 120, signatureStatus: null })).toBe("live");
    expect(classifyPreparedSponsorshipState({ ...base, currentBlockHeight: 121, signatureStatus: null })).toBe("expired");
    expect(classifyPreparedSponsorshipState({ ...base, currentBlockHeight: 121, signatureStatus: { confirmationStatus: "confirmed", err: null } })).toBe("submitted_pending");
    expect(classifyPreparedSponsorshipState({ ...base, currentBlockHeight: 121, signatureStatus: { confirmationStatus: "finalized", err: null } })).toBe("finalized_success");
    expect(classifyPreparedSponsorshipState({ ...base, currentBlockHeight: 121, signatureStatus: { confirmationStatus: "finalized", err: { InstructionError: [0, "Custom"] } } })).toBe("finalized_failure");
  });

  it.each([
    { currentBlockHeight: -1, lastValidBlockHeight: 10 },
    { currentBlockHeight: 10.5, lastValidBlockHeight: 10 },
    { currentBlockHeight: 10, lastValidBlockHeight: -1 }
  ])("rejects invalid block-height evidence: %o", (heights) => {
    expect(() => classifyPreparedSponsorshipState({ ...heights, signatureStatus: null })).toThrow("sponsorship_block_height_invalid");
  });

  it("fails closed on unavailable or failed simulation", () => {
    expect(() => assertSimulationSucceeded(null)).toThrow("sponsored_simulation_unavailable");
    expect(() => assertSimulationSucceeded({ value: { err: { InstructionError: [0, "Custom"] } } }))
      .toThrow("sponsored_simulation_failed");
    expect(() => assertSimulationSucceeded({ value: { err: null, unitsConsumed: 1_500_000 } }))
      .toThrow("sponsored_compute_limit_exceeded");
    expect(() => assertSimulationSucceeded({ value: { err: null, unitsConsumed: 80_000 } })).not.toThrow();
  });
});


describe("company-sponsored confidential-account setup instruction policy", () => {
  const gasTank = "gas-tank";
  const owner = "contributor";
  const token = "derived-associated-token";
  const mint = "wrapped-usdc-mint";
  const system = "11111111111111111111111111111111";
  const token2022 = "token-2022";
  const associated = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsJJA8knL";
  const instructionsSysvar = "Sysvar1nstructions1111111111111111111111111";
  const proof = "ZkE1Gama1Proof11111111111111111111111111111";
  const message = (instructions: Array<{programAddressIndex:number;accountIndices:number[];data:Uint8Array}>) => ({
    version: 0,
    staticAccounts: [gasTank, owner, token, mint, system, token2022, associated, instructionsSysvar, proof],
    header: { numSignerAccounts: 2, numReadonlySignerAccounts: 1, numReadonlyNonSignerAccounts: 6 },
    instructions,
    addressTableLookups: []
  });
  const setupInput = (instructions: Array<{programAddressIndex:number;accountIndices:number[];data:Uint8Array}>) => ({
    message: message(instructions),
    feePayerAddress: gasTank,
    ownerAddress: owner,
    mintAddress: mint,
    tokenAccountAddress: token,
    token2022ProgramAddress: token2022
  });

  it("permits the contributor-owned associated account and confidential configuration", () => {
    expect(assertAllowedConfidentialAccountSetupMessage(setupInput([
      { programAddressIndex: 6, accountIndices: [0, 2, 1, 3, 4, 5], data: Uint8Array.of(1) },
      { programAddressIndex: 5, accountIndices: [2, 3, 7, 1], data: Uint8Array.of(27, 2, 0, 0) },
      { programAddressIndex: 8, accountIndices: [], data: Uint8Array.of(4, 1, 2) },
      { programAddressIndex: 8, accountIndices: [], data: Uint8Array.of(1, 1, 2) }
    ])).reservedRentLamports).toBe(MAX_CONFIDENTIAL_ACCOUNT_SETUP_RENT_LAMPORTS);
  });

  it("rejects Token-2022 transfer instructions and unknown programs", () => {
    expect(() => assertAllowedConfidentialAccountSetupMessage(setupInput([
      { programAddressIndex: 5, accountIndices: [2, 1], data: Uint8Array.of(3, 1, 0) }
    ]))).toThrow("confidential_setup_token_instruction_denied");
    expect(() => assertAllowedConfidentialAccountSetupMessage(setupInput([
      { programAddressIndex: 8, accountIndices: [], data: Uint8Array.of(0) }
    ]))).toThrow("confidential_setup_proof_instruction_denied");
  });

  it("rejects a transaction without contributor signer authorization or with a different fee payer", () => {
    const noOwnerSigner = setupInput([
      { programAddressIndex: 6, accountIndices: [0, 2, 1, 3, 4, 5], data: Uint8Array.of(1) }
    ]);
    noOwnerSigner.message.header.numSignerAccounts = 1;
    noOwnerSigner.message.header.numReadonlySignerAccounts = 0;
    expect(() => assertAllowedConfidentialAccountSetupMessage(noOwnerSigner))
      .toThrow("confidential_setup_owner_signature_required");
    expect(() => assertAllowedConfidentialAccountSetupMessage({
      ...setupInput([
        { programAddressIndex: 8, accountIndices: [], data: Uint8Array.of(4, 1) }
      ]),
      feePayerAddress: "attacker"
    })).toThrow("confidential_setup_transaction_invalid");
  });

  it("rejects excessive proof-account rent and address-table transactions", () => {
    const systemCreate = new Uint8Array(52);
    new DataView(systemCreate.buffer).setUint32(0, 0, true);
    new DataView(systemCreate.buffer).setBigUint64(4, MAX_CONFIDENTIAL_ACCOUNT_SETUP_RENT_LAMPORTS + 1n, true);
    new DataView(systemCreate.buffer).setBigUint64(12, 128n, true);
    systemCreate.set(getAddressEncoder().encode(address(proof)), 20);
    const excessiveRent = setupInput([
      { programAddressIndex: 4, accountIndices: [0, 1], data: systemCreate }
    ]);
    excessiveRent.message.header.numReadonlySignerAccounts = 0;
    expect(() => assertAllowedConfidentialAccountSetupMessage(excessiveRent))
      .toThrow("confidential_setup_proof_account_denied");
    const withLookup = setupInput([
      { programAddressIndex: 8, accountIndices: [], data: Uint8Array.of(4, 1) }
    ]);
    withLookup.message.addressTableLookups = [{}];
    expect(() => assertAllowedConfidentialAccountSetupMessage(withLookup))
      .toThrow("confidential_setup_transaction_invalid");
  });
});
