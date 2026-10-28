import test from "node:test";
import assert from "node:assert/strict";
import { auditPayrollProgramIdl, EXPECTED_PAYLORE_PROGRAM_ID } from "./audit-payroll-program-idl.mjs";

const byte32 = { array: ["u8", 32] };
const vecByte32 = { vec: byte32 };
const definedClaimStatus = { defined: { name: "ClaimStatus" } };
const anchorConfig = [
  "[toolchain]",
  'anchor_version = "1.2.0"',
  "",
  "[programs.devnet]",
  'paylore_payroll = "' + EXPECTED_PAYLORE_PROGRAM_ID + '"',
  "",
  "[provider]",
  'cluster = "Devnet"',
  'wallet = "~/.config/solana/id.json"'
].join("\n");
const source = "declare_id!(\"4zYM9ZjwbAz9jxQ2C69Z83n1s4wceCPk7VzDLKoUnT93\");\n#[program]\npub mod paylore_payroll {\npub fn initialize_workspace(ctx: Context<InitializeWorkspace>, workspace_id: String, workspace_seed: [u8; 32]) -> Result<()> {}\npub fn create_claim(ctx: Context<CreateClaim>, claim_id: [u8; 32], allocation_commitment: [u8; 32], amount_commitment: [u8; 32], amount_commitment_leaf_index: u32, amount_commitment_proof: Vec<[u8; 32]>, escrow_token_account: Pubkey) -> Result<()> {}\npub fn configure_workspace_reserve(ctx: Context<ConfigureWorkspaceReserve>) -> Result<()> {}\npub fn mark_settlement_pending(ctx: Context<MarkSettlementPending>) -> Result<()> {}\npub fn mark_claimed(ctx: Context<MarkClaimed>) -> Result<()> {}\npub fn mark_claim_escrow_funded(ctx: Context<MarkClaimEscrowFunded>) -> Result<()> {}\npub fn recover_claim(ctx: Context<RecoverClaim>, recovery_reason_commitment: [u8; 32]) -> Result<()> {}\npub fn finalize_claimed(ctx: Context<FinalizeClaimed>) -> Result<()> {}\n}\npub struct InitializeWorkspace {\n  pub authority: Signer<'info>,\n  pub workspace: Account<'info, WorkspaceState>,\n  pub system_program: Program<'info, System>,\n}\npub struct CreateClaim {\n  pub authority: Signer<'info>,\n  pub contributor: UncheckedAccount<'info>,\n  pub workspace: Account<'info, WorkspaceState>,\n  pub claim: Account<'info, ClaimState>,\n  pub system_program: Program<'info, System>,\n}\npub struct ConfigureWorkspaceReserve {\n  pub authority: UncheckedAccount<'info>,\n  pub workspace: Account<'info, WorkspaceState>,\n  pub reserve_state: Account<'info, WorkspaceReserveState>,\n  pub reserve_authority: Signer<'info>,\n  pub reserve_token_account: UncheckedAccount<'info>,\n  pub mint: UncheckedAccount<'info>,\n  pub system_program: Program<'info, System>,\n}\npub struct MarkSettlementPending {\n  pub contributor: UncheckedAccount<'info>,\n  pub workspace: Account<'info, WorkspaceState>,\n  pub reserve_state: Account<'info, WorkspaceReserveState>,\n  pub reserve_authority: Signer<'info>,\n  pub reserve_token_account: UncheckedAccount<'info>,\n  pub mint: UncheckedAccount<'info>,\n  pub claim: Account<'info, ClaimState>,\n  pub escrow_token_account: UncheckedAccount<'info>,\n  pub destination_token_account: UncheckedAccount<'info>,\n  pub instructions_sysvar: UncheckedAccount<'info>,\n  pub amount_commitment_context: UncheckedAccount<'info>,\n}\npub struct MarkClaimed {\n  pub contributor: UncheckedAccount<'info>,\n  pub workspace: Account<'info, WorkspaceState>,\n  pub reserve_state: Account<'info, WorkspaceReserveState>,\n  pub reserve_authority: Signer<'info>,\n  pub reserve_token_account: UncheckedAccount<'info>,\n  pub mint: UncheckedAccount<'info>,\n  pub claim: Account<'info, ClaimState>,\n  pub escrow_token_account: UncheckedAccount<'info>,\n  pub destination_token_account: UncheckedAccount<'info>,\n  pub instructions_sysvar: UncheckedAccount<'info>,\n  pub amount_commitment_context: UncheckedAccount<'info>,\n}\npub struct MarkClaimEscrowFunded {\n  pub contributor: UncheckedAccount<'info>,\n  pub workspace: Account<'info, WorkspaceState>,\n  pub reserve_state: Account<'info, WorkspaceReserveState>,\n  pub reserve_authority: Signer<'info>,\n  pub reserve_token_account: UncheckedAccount<'info>,\n  pub mint: UncheckedAccount<'info>,\n  pub claim: Account<'info, ClaimState>,\n  pub escrow_token_account: UncheckedAccount<'info>,\n  pub instructions_sysvar: UncheckedAccount<'info>,\n  pub amount_commitment_context: UncheckedAccount<'info>,\n}\npub struct RecoverClaim {\n  pub contributor: UncheckedAccount<'info>,\n  pub workspace: Account<'info, WorkspaceState>,\n  pub reserve_state: Account<'info, WorkspaceReserveState>,\n  pub reserve_authority: Signer<'info>,\n  pub reserve_token_account: UncheckedAccount<'info>,\n  pub mint: UncheckedAccount<'info>,\n  pub claim: Account<'info, ClaimState>,\n  pub escrow_token_account: UncheckedAccount<'info>,\n  pub instructions_sysvar: UncheckedAccount<'info>,\n  pub amount_commitment_context: UncheckedAccount<'info>,\n}\npub struct FinalizeClaimed {\n  pub contributor: UncheckedAccount<'info>,\n  pub workspace: Account<'info, WorkspaceState>,\n  pub reserve_state: Account<'info, WorkspaceReserveState>,\n  pub reserve_authority: Signer<'info>,\n  pub claim: Account<'info, ClaimState>,\n  pub instructions_sysvar: UncheckedAccount<'info>,\n}\npub struct ClaimState {\n  pub workspace: Pubkey,\n  pub contributor: Pubkey,\n  pub claim_id: [u8; 32],\n  pub allocation_commitment: [u8; 32],\n  pub amount_commitment: [u8; 32],\n  pub escrow_token_account: Pubkey,\n  pub escrow_funded: bool,\n  pub status: ClaimStatus,\n  pub bump: u8,\n}\nimpl ClaimState { pub const SPACE: usize = 8 + 32 + 32 + 32 + 32 + 32 + 32 + 1 + 1 + 1; }\npub enum ClaimStatus {\n  Unclaimed,\n  Claimed,\n  Recovered,\n  SettlementPending,\n}";

function instruction(name, accounts, args = []) {
  return { name, accounts: accounts.map((item) => ({ name: item })), args: args.map(([argName, type]) => ({ name: argName, type })) };
}

function validIdl() {
  return {
    address: EXPECTED_PAYLORE_PROGRAM_ID,
    instructions: [
      instruction("initializeWorkspace", ["authority", "workspace", "systemProgram"], [["workspaceId", "string"], ["workspaceSeed", byte32]]),
      instruction("createClaim", ["authority", "contributor", "workspace", "claim", "systemProgram"], [["claimId", byte32], ["allocationCommitment", byte32], ["amountCommitment", byte32], ["amountCommitmentLeafIndex", "u32"], ["amountCommitmentProof", vecByte32], ["escrowTokenAccount", "pubkey"]]),
      instruction("configureWorkspaceReserve", ["authority", "workspace", "reserveState", "reserveAuthority", "reserveTokenAccount", "mint", "systemProgram"]),
      instruction("markSettlementPending", ["contributor", "workspace", "reserveState", "reserveAuthority", "reserveTokenAccount", "mint", "claim", "escrowTokenAccount", "destinationTokenAccount", "instructionsSysvar", "amountCommitmentContext"]),
      instruction("markClaimed", ["contributor", "workspace", "reserveState", "reserveAuthority", "reserveTokenAccount", "mint", "claim", "escrowTokenAccount", "destinationTokenAccount", "instructionsSysvar", "amountCommitmentContext"]),
      instruction("markClaimEscrowFunded", ["contributor", "workspace", "reserveState", "reserveAuthority", "reserveTokenAccount", "mint", "claim", "escrowTokenAccount", "instructionsSysvar", "amountCommitmentContext"]),
      instruction("recoverClaim", ["contributor", "workspace", "reserveState", "reserveAuthority", "reserveTokenAccount", "mint", "claim", "escrowTokenAccount", "instructionsSysvar", "amountCommitmentContext"], [["recoveryReasonCommitment", byte32]]),
      instruction("finalizeClaimed", ["contributor", "workspace", "reserveState", "reserveAuthority", "claim", "instructionsSysvar"])
    ],
    types: [
      { name: "ClaimState", type: { kind: "struct", fields: [
        { name: "workspace", type: "pubkey" }, { name: "contributor", type: "pubkey" }, { name: "claimId", type: byte32 },
        { name: "allocationCommitment", type: byte32 }, { name: "amountCommitment", type: byte32 },
        { name: "escrowTokenAccount", type: "pubkey" }, { name: "escrowFunded", type: "bool" },
        { name: "status", type: definedClaimStatus }, { name: "bump", type: "u8" }
      ] } },
      { name: "ClaimStatus", type: { kind: "enum", variants: [{ name: "unclaimed" }, { name: "claimed" }, { name: "recovered" }, { name: "settlementPending" }] } }
    ]
  };
}

test("accepts the existing Devnet Program ID and complete source/IDL ABI", () => {
  assert.deepEqual(auditPayrollProgramIdl({ idl: validIdl(), source, anchorConfig }), {
    programId: EXPECTED_PAYLORE_PROGRAM_ID,
    verifiedInstructions: ["initialize_workspace", "create_claim", "configure_workspace_reserve", "mark_settlement_pending", "mark_claimed", "mark_claim_escrow_funded", "recover_claim", "finalize_claimed"],
    verifiedAccountLayouts: ["ClaimState", "ClaimStatus"]
  });
});

test("rejects an IDL for a replacement or different-network program", () => {
  assert.throws(() => auditPayrollProgramIdl({ idl: { ...validIdl(), address: "11111111111111111111111111111111" }, source }), /IDL address does not match/);
});

test("rejects program source whose deployed ID has changed", () => {
  assert.throws(() => auditPayrollProgramIdl({ idl: validIdl(), source: source.replace(EXPECTED_PAYLORE_PROGRAM_ID, "11111111111111111111111111111111") }), /source declare_id/);
});

test("rejects changes to a generated security-critical account order", () => {
  const idl = validIdl();
  idl.instructions.find((item) => item.name === "recoverClaim").accounts.reverse();
  assert.throws(() => auditPayrollProgramIdl({ idl, source }), /Generated IDL account order/);
});

test("rejects an account context change even when the IDL is left unchanged", () => {
  const alteredSource = source.replace("pub struct RecoverClaim {\n  pub contributor:", "pub struct RecoverClaim {\n  pub reserve_authority:");
  assert.throws(() => auditPayrollProgramIdl({ idl: validIdl(), source: alteredSource }), /source account order/);
});

test("rejects a generated recovery instruction missing its reason commitment", () => {
  const idl = validIdl();
  idl.instructions.find((item) => item.name === "recoverClaim").args = [];
  assert.throws(() => auditPayrollProgramIdl({ idl, source }), /argument order/);
});

test("rejects an IDL whose claim amount leaf-index type no longer matches Rust", () => {
  const idl = validIdl();
  idl.instructions.find((item) => item.name === "createClaim").args[3].type = "u64";
  assert.throws(() => auditPayrollProgramIdl({ idl, source }), /Generated IDL type for "create_claim" argument "amount_commitment_leaf_index" differs/);
});

test("rejects a stale account decoder field order", () => {
  const idl = validIdl();
  idl.types.find((item) => item.name === "ClaimState").type.fields.reverse();
  assert.throws(() => auditPayrollProgramIdl({ idl, source }), /Generated IDL ClaimState field order/);
});

test("rejects a changed state byte encoding", () => {
  const idl = validIdl();
  idl.types.find((item) => item.name === "ClaimStatus").type.variants.reverse();
  assert.throws(() => auditPayrollProgramIdl({ idl, source }), /ClaimStatus variant order/);
});

test("rejects a non-Devnet Anchor provider target", () => {
  const config = anchorConfig.replace('cluster = "Devnet"', 'cluster = "Mainnet"');
  assert.throws(() => auditPayrollProgramIdl({ idl: validIdl(), source, anchorConfig: config }), /must remain Devnet/);
});

test("rejects a different program address in the Devnet Anchor map", () => {
  const config = anchorConfig.replace(EXPECTED_PAYLORE_PROGRAM_ID, "11111111111111111111111111111111");
  assert.throws(() => auditPayrollProgramIdl({ idl: validIdl(), source, anchorConfig: config }), /must map paylore_payroll/);
});

test("rejects configuring the existing Payroll Program under Mainnet", () => {
  const config = anchorConfig + '\n[programs.mainnet]\npaylore_payroll = "' + EXPECTED_PAYLORE_PROGRAM_ID + '"\n';
  assert.throws(() => auditPayrollProgramIdl({ idl: validIdl(), source, anchorConfig: config }), /must not be configured for Mainnet/);
});
