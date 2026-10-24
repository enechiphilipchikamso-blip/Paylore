import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const EXPECTED_PAYLORE_PROGRAM_ID = "4zYM9ZjwbAz9jxQ2C69Z83n1s4wceCPk7VzDLKoUnT93";

function normalize(name) {
  return String(name ?? "").replace(/[_-]/g, "").toLowerCase();
}

function requiredInstruction(instructions, name, accounts, args = []) {
  const actual = instructions.find((item) => normalize(item.name) === normalize(name));
  if (!actual) throw new Error(`Generated IDL is missing instruction "${name}".`);
  if (!Array.isArray(actual.accounts)) {
    throw new Error(`Generated IDL instruction "${name}" has no flat account list.`);
  }
  const actualAccounts = actual.accounts.map((item) => normalize(item.name));
  const expectedAccounts = accounts.map(normalize);
  if (JSON.stringify(actualAccounts) !== JSON.stringify(expectedAccounts)) {
    throw new Error(
      `Generated IDL account order for "${name}" differs from the Payroll Program source. ` +
      `Expected [${accounts.join(", ")}], received [${actual.accounts.map((item) => item.name).join(", ")}].`
    );
  }
  const actualArgs = Array.isArray(actual.args) ? actual.args.map((item) => normalize(item.name)) : [];
  for (const arg of args) {
    if (!actualArgs.includes(normalize(arg))) {
      throw new Error(`Generated IDL instruction "${name}" is missing argument "${arg}".`);
    }
  }
  return actual;
}

/** Verifies generated account and instruction metadata against the security-critical Rust instruction contexts. */
export function auditPayrollProgramIdl({ idl, source }) {
  if (!idl || typeof idl !== "object" || !Array.isArray(idl.instructions)) {
    throw new Error("Generated Payroll Program IDL is malformed or has no instruction list.");
  }
  const sourceId = source.match(/declare_id!\(["']([^"']+)["']\)/)?.[1];
  if (!sourceId || sourceId !== EXPECTED_PAYLORE_PROGRAM_ID) {
    throw new Error("Payroll Program source declare_id does not match the approved existing Devnet Program ID.");
  }
  const idlId = idl.address ?? idl.metadata?.address;
  if (idlId !== sourceId) {
    throw new Error("Generated Payroll Program IDL address does not match the source Program ID.");
  }

  requiredInstruction(idl.instructions, "configure_workspace_reserve", [
    "authority", "workspace", "reserve_state", "reserve_authority",
    "reserve_token_account", "mint", "system_program"
  ]);
  requiredInstruction(idl.instructions, "mark_settlement_pending", [
    "contributor", "workspace", "reserve_state", "reserve_authority",
    "reserve_token_account", "mint", "claim", "escrow_token_account",
    "destination_token_account", "instructions_sysvar", "amount_commitment_context"
  ]);
  requiredInstruction(idl.instructions, "mark_claimed", [
    "contributor", "workspace", "reserve_state", "reserve_authority",
    "reserve_token_account", "mint", "claim", "escrow_token_account",
    "destination_token_account", "instructions_sysvar", "amount_commitment_context"
  ]);
  requiredInstruction(idl.instructions, "recover_claim", [
    "contributor", "workspace", "reserve_state", "reserve_authority",
    "reserve_token_account", "mint", "claim", "escrow_token_account",
    "instructions_sysvar", "amount_commitment_context"
  ], ["recovery_reason_commitment"]);
  requiredInstruction(idl.instructions, "finalize_claimed", [
    "contributor", "workspace", "reserve_state", "reserve_authority", "claim"
  ]);
  return {
    programId: sourceId,
    verifiedInstructions: [
      "configure_workspace_reserve",
      "mark_settlement_pending",
      "mark_claimed",
      "recover_claim",
      "finalize_claimed"
    ]
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const idlPath = resolve(process.argv[2] ?? "target/idl/paylore_payroll.json");
  const sourcePath = resolve(process.argv[3] ?? "programs/payroll/src/lib.rs");
  let idl;
  try {
    idl = JSON.parse(readFileSync(idlPath, "utf8"));
  } catch (error) {
    throw new Error(`Unable to read generated IDL at ${idlPath}. Run anchor build before this audit.`, {
      cause: error
    });
  }
  const source = readFileSync(sourcePath, "utf8");
  const result = auditPayrollProgramIdl({ idl, source });
  process.stdout.write(
    JSON.stringify({ status: "source_idl_parity_verified", ...result }, null, 2) + "\n"
  );
}
