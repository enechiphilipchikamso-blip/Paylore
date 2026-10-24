import test from "node:test";
import assert from "node:assert/strict";
import { auditPayrollProgramIdl, EXPECTED_PAYLORE_PROGRAM_ID } from "./audit-payroll-program-idl.mjs";

const source = `declare_id!("4zYM9ZjwbAz9jxQ2C69Z83n1s4wceCPk7VzDLKoUnT93");`;

function instruction(name, accounts, args = []) {
  return { name, accounts: accounts.map((item) => ({ name: item })), args: args.map((item) => ({ name: item, type: "bytes" })) };
}

function validIdl() {
  return {
    address: EXPECTED_PAYLORE_PROGRAM_ID,
    instructions: [
      instruction("configureWorkspaceReserve", [
        "authority", "workspace", "reserveState", "reserveAuthority",
        "reserveTokenAccount", "mint", "systemProgram"
      ]),
      instruction("markSettlementPending", [
        "contributor", "workspace", "reserveState", "reserveAuthority",
        "reserveTokenAccount", "mint", "claim", "escrowTokenAccount",
        "destinationTokenAccount", "instructionsSysvar", "amountCommitmentContext"
      ]),
      instruction("markClaimed", [
        "contributor", "workspace", "reserveState", "reserveAuthority",
        "reserveTokenAccount", "mint", "claim", "escrowTokenAccount",
        "destinationTokenAccount", "instructionsSysvar", "amountCommitmentContext"
      ]),
      instruction("recoverClaim", [
        "contributor", "workspace", "reserveState", "reserveAuthority",
        "reserveTokenAccount", "mint", "claim", "escrowTokenAccount",
        "instructionsSysvar", "amountCommitmentContext"
      ], ["recoveryReasonCommitment"]),
      instruction("finalizeClaimed", [
        "contributor", "workspace", "reserveState", "reserveAuthority", "claim"
      ])
    ]
  };
}

test("accepts the approved Devnet Program ID and security-critical generated IDL shapes", () => {
  assert.deepEqual(auditPayrollProgramIdl({ idl: validIdl(), source }), {
    programId: EXPECTED_PAYLORE_PROGRAM_ID,
    verifiedInstructions: [
      "configure_workspace_reserve",
      "mark_settlement_pending",
      "mark_claimed",
      "recover_claim",
      "finalize_claimed"
    ]
  });
});

test("rejects an IDL for a replacement or different-network program", () => {
  assert.throws(
    () => auditPayrollProgramIdl({
      idl: { ...validIdl(), address: "11111111111111111111111111111111" },
      source
    }),
    /IDL address does not match/
  );
});

test("rejects changes to the recovery account order", () => {
  const idl = validIdl();
  idl.instructions.find((item) => item.name === "recoverClaim").accounts.reverse();
  assert.throws(
    () => auditPayrollProgramIdl({ idl, source }),
    /account order/
  );
});

test("rejects a generated recovery instruction without its reason commitment", () => {
  const idl = validIdl();
  idl.instructions.find((item) => item.name === "recoverClaim").args = [];
  assert.throws(
    () => auditPayrollProgramIdl({ idl, source }),
    /missing argument "recovery_reason_commitment"/
  );
});

test("rejects source changes to the approved existing Program ID", () => {
  assert.throws(
    () => auditPayrollProgramIdl({
      idl: validIdl(),
      source: source.replace(EXPECTED_PAYLORE_PROGRAM_ID, "11111111111111111111111111111111")
    }),
    /source declare_id/
  );
});
