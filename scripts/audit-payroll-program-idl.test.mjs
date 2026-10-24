import test from "node:test";
import assert from "node:assert/strict";
import { auditPayrollProgramIdl, EXPECTED_PAYLORE_PROGRAM_ID } from "./audit-payroll-program-idl.mjs";

const byte32 = { array: ["u8", 32] };
const vecByte32 = { vec: byte32 };
const definedClaimStatus = { defined: { name: "ClaimStatus" } };
const source = \`
declare_id!("4zYM9ZjwbAz9jxQ2C69Z83n1s4wceCPk7VzDLKoUnT93");
#[program]
pub mod paylore_payroll {
  pub fn initialize_workspace(ctx: Context<InitializeWorkspace>, workspace_id: String, workspace_seed: [u8; 32]) -> Result<()> {}
  pub fn create_claim(ctx: Context<CreateClaim>, claim_id: [u8; 32], allocation_commitment: [u8; 32], amount_commitment: [u8; 32], amount_commitment_leaf_index: u32, amount_commitment_proof: Vec<[u8; 32]>, escrow_token_account: Pubkey) -> Result<()> {}
  pub fn configure_workspace_reserve(ctx: Context<ConfigureWorkspaceReserve>) -> Result<()> {}
  pub fn mark_settlement_pending(ctx: Context<MarkSettlementPending>) -> Result<()> {}
  pub fn mark_claimed(ctx: Context<MarkClaimed>) -> Result<()> {}
  pub fn mark_claim_escrow_funded(ctx: Context<MarkClaimEscrowFunded>) -> Result<()> {}
  pub fn recover_claim(ctx: Context<RecoverClaim>, recovery_reason_commitment: [u8; 32]) -> Result<()> {}
  pub fn finalize_claimed(ctx: Context<FinalizeClaimed>) -> Result<()> {}
}
pub struct InitializeWorkspace { pub authority: Signer<'info>, pub workspace: Account<'info, WorkspaceState>, pub system_program: Program<'info, System>, }
pub struct CreateClaim { pub authority: Signer<'info>, pub contributor: UncheckedAccount<'info>, pub workspace: Account<'info, WorkspaceState>, pub claim: Account<'info, ClaimState>, pub system_program: Program<'info, System>, }
pub struct ConfigureWorkspaceReserve { pub authority: UncheckedAccount<'info>, pub workspace: Account<'info, WorkspaceState>, pub reserve_state: Account<'info, WorkspaceReserveState>, pub reserve_authority: Signer<'info>, pub reserve_token_account: UncheckedAccount<'info>, pub mint: UncheckedAccount<'info>, pub system_program: Program<'info, System>, }
pub struct MarkSettlementPending { pub contributor: UncheckedAccount<'info>, pub workspace: Account<'info, WorkspaceState>, pub reserve_state: Account<'info, WorkspaceReserveState>, pub reserve_authority: Signer<'info>, pub reserve_token_account: UncheckedAccount<'info>, pub mint: UncheckedAccount<'info>, pub claim: Account<'info, ClaimState>, pub escrow_token_account: UncheckedAccount<'info>, pub destination_token_account: UncheckedAccount<'info>, pub instructions_sysvar: UncheckedAccount<'info>, pub amount_commitment_context: UncheckedAccount<'info>, }
pub struct MarkClaimed { pub contributor: UncheckedAccount<'info>, pub workspace: Account<'info, WorkspaceState>, pub reserve_state: Account<'info, WorkspaceReserveState>, pub reserve_authority: Signer<'info>, pub reserve_token_account: UncheckedAccount<'info>, pub mint: UncheckedAccount<'info>, pub claim: Account<'info, ClaimState>, pub escrow_token_account: UncheckedAccount<'info>, pub destination_token_account: UncheckedAccount<'info>, pub instructions_sysvar: UncheckedAccount<'info>, pub amount_commitment_context: UncheckedAccount<'info>, }
pub struct MarkClaimEscrowFunded { pub contributor: UncheckedAccount<'info>, pub workspace: Account<'info, WorkspaceState>, pub reserve_state: Account<'info, WorkspaceReserveState>, pub reserve_authority: Signer<'info>, pub reserve_token_account: UncheckedAccount<'info>, pub mint: UncheckedAccount<'info>, pub claim: Account<'info, ClaimState>, pub escrow_token_account: UncheckedAccount<'info>, pub instructions_sysvar: UncheckedAccount<'info>, pub amount_commitment_context: UncheckedAccount<'info>, }
pub struct RecoverClaim { pub contributor: UncheckedAccount<'info>, pub workspace: Account<'info, WorkspaceState>, pub reserve_state: Account<'info, WorkspaceReserveState>, pub reserve_authority: Signer<'info>, pub reserve_token_account: UncheckedAccount<'info>, pub mint: UncheckedAccount<'info>, pub claim: Account<'info, ClaimState>, pub escrow_token_account: UncheckedAccount<'info>, pub instructions_sysvar: UncheckedAccount<'info>, pub amount_commitment_context: UncheckedAccount<'info>, }
pub struct FinalizeClaimed { pub contributor: UncheckedAccount<'info>, pub workspace: Account<'info, WorkspaceState>, pub reserve_state: Account<'info, WorkspaceReserveState>, pub reserve_authority: Signer<'info>, pub claim: Account<'info, ClaimState>, }
pub struct ClaimState {
 pub workspace: Pubkey,
 pub contributor: Pubkey,
 pub claim_id: [u8; 32],
 pub allocation_commitment: [u8; 32],
 pub amount_commitment: [u8; 32],
 pub escrow_token_account: Pubkey,
 pub escrow_funded: bool,
 pub status: ClaimStatus,
 pub bump: u8,
}
impl ClaimState { pub const SPACE: usize = 8 + 32 + 32 + 32 + 32 + 32 + 32 + 1 + 1 + 1; }
pub enum ClaimStatus { Unclaimed, Claimed, Recovered, SettlementPending, }
\`;

function instruction(name, accounts, args = []) {
  return {
    name,
    accounts: accounts.map((item) => ({ name: item })),
    args: args.map(([argName, type]) => ({ name: argName, type }))
  };
}

function validIdl() {
  return {
    address: EXPECTED_PAYLORE_PROGRAM_ID,
    instructions: [
      instruction("initializeWorkspace", ["authority", "workspace", "systemProgram"], [
        ["workspaceId", "string"], ["workspaceSeed", byte32]
      ]),
      instruction("createClaim", ["authority", "contributor", "workspace", "claim", "systemProgram"], [
        ["claimId", byte32], ["allocationCommitment", byte32], ["amountCommitment", byte32],
        ["amountCommitmentLeafIndex", "u32"], ["amountCommitmentProof", vecByte32],
        ["escrowTokenAccount", "pubkey"]
      ]),
      instruction("configureWorkspaceReserve", [
        "authority", "workspace", "reserveState", "reserveAuthority", "reserveTokenAccount", "mint", "systemProgram"
      ]),
      instruction("markSettlementPending", [
        "contributor", "workspace", "reserveState", "reserveAuthority", "reserveTokenAccount", "mint",
        "claim", "escrowTokenAccount", "destinationTokenAccount", "instructionsSysvar", "amountCommitmentContext"
      ]),
      instruction("markClaimed", [
        "contributor", "workspace", "reserveState", "reserveAuthority", "reserveTokenAccount", "mint",
        "claim", "escrowTokenAccount", "destinationTokenAccount", "instructionsSysvar", "amountCommitmentContext"
      ]),
      instruction("markClaimEscrowFunded", [
        "contributor", "workspace", "reserveState", "reserveAuthority", "reserveTokenAccount", "mint",
        "claim", "escrowTokenAccount", "instructionsSysvar", "amountCommitmentContext"
      ]),
      instruction("recoverClaim", [
        "contributor", "workspace", "reserveState", "reserveAuthority", "reserveTokenAccount", "mint",
        "claim", "escrowTokenAccount", "instructionsSysvar", "amountCommitmentContext"
      ], [["recoveryReasonCommitment", byte32]]),
      instruction("finalizeClaimed", ["contributor", "workspace", "reserveState", "reserveAuthority", "claim"])
    ],
    types: [
      {
        name: "ClaimState",
        type: { kind: "struct", fields: [
          ["workspace", "pubkey"], ["contributor", "pubkey"], ["claimId", byte32],
          ["allocationCommitment", byte32], ["amountCommitment", byte32],
          ["escrowTokenAccount", "pubkey"], ["escrowFunded", "bool"],
          ["status", definedClaimStatus], ["bump", "u8"]
        ].map(([name, type]) => ({ name, type })) }
      },
      {
        name: "ClaimStatus",
        type: { kind: "enum", variants: [
          { name: "unclaimed" }, { name: "claimed" }, { name: "recovered" }, { name: "settlementPending" }
        ] }
      }
    ]
  };
}

test("accepts the existing Devnet Program ID and complete source/IDL ABI", () => {
  assert.deepEqual(auditPayrollProgramIdl({ idl: validIdl(), source }), {
    programId: EXPECTED_PAYLORE_PROGRAM_ID,
    verifiedInstructions: [
      "initialize_workspace",
      "create_claim",
      "configure_workspace_reserve",
      "mark_settlement_pending",
      "mark_claimed",
      "mark_claim_escrow_funded",
      "recover_claim",
      "finalize_claimed"
    ],
    verifiedAccountLayouts: ["ClaimState", "ClaimStatus"]
  });
});

test("rejects an IDL for a replacement or different-network program", () => {
  assert.throws(
    () => auditPayrollProgramIdl({ idl: { ...validIdl(), address: "11111111111111111111111111111111" }, source }),
    /IDL address does not match/
  );
});

test("rejects program source whose deployed ID has changed", () => {
  assert.throws(
    () => auditPayrollProgramIdl({
      idl: validIdl(),
      source: source.replace(EXPECTED_PAYLORE_PROGRAM_ID, "11111111111111111111111111111111")
    }),
    /source declare_id/
  );
});

test("rejects changes to a generated security-critical account order", () => {
  const idl = validIdl();
  idl.instructions.find((item) => item.name === "recoverClaim").accounts.reverse();
  assert.throws(() => auditPayrollProgramIdl({ idl, source }), /Generated IDL account order/);
});

test("rejects an account context change even when the IDL is left unchanged", () => {
  const alteredSource = source.replace(
    "pub struct RecoverClaim { pub contributor:",
    "pub struct RecoverClaim { pub reserve_authority:"
  );
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
  assert.throws(() => auditPayrollProgramIdl({ idl, source }), /argument "amount_commitment_leaf_index".*approved ABI/);
});

test("rejects a stale account decoder field order", () => {
  const idl = validIdl();
  idl.types.find((item) => item.name === "ClaimState").type.fields.reverse();
  assert.throws(() => auditPayrollProgramIdl({ idl, source }), /ClaimState field order/);
});

test("rejects a changed state byte encoding", () => {
  const idl = validIdl();
  idl.types.find((item) => item.name === "ClaimStatus").type.variants.reverse();
  assert.throws(() => auditPayrollProgramIdl({ idl, source }), /ClaimStatus variant order/);
});
