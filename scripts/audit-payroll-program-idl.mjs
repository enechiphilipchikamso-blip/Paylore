import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const EXPECTED_PAYLORE_PROGRAM_ID = "4zYM9ZjwbAz9jxQ2C69Z83n1s4wceCPk7VzDLKoUnT93";

function normalize(name) {
  return String(name ?? "").replace(/[_-]/g, "").toLowerCase();
}

function canonicalType(value) {
  if (typeof value === "string") return normalize(value);
  if (Array.isArray(value)) return value.map(canonicalType).join(",");
  if (!value || typeof value !== "object") return String(value);
  if (Array.isArray(value.array) && value.array.length === 2) {
    return "array:" + canonicalType(value.array[0]) + ":" + value.array[1];
  }
  if ("vec" in value) return "vec:" + canonicalType(value.vec);
  if ("option" in value) return "option:" + canonicalType(value.option);
  if ("defined" in value) {
    const defined = value.defined;
    const name = typeof defined === "string" ? defined : defined?.name;
    return "defined:" + normalize(name);
  }
  return JSON.stringify(value, Object.keys(value).sort());
}


function tomlSectionValues(document, wantedSection) {
  const values = {};
  let section = "";
  for (const line of document.split(/\r?\n/)) {
    const header = line.match(/^\s*\[([^\]]+)\]\s*$/);
    if (header) {
      section = header[1];
      continue;
    }
    if (section !== wantedSection) continue;
    const assignment = line.match(/^\s*([A-Za-z0-9_]+)\s*=\s*["']([^"']*)["']\s*$/);
    if (assignment) values[assignment[1]] = assignment[2];
  }
  return values;
}

function auditAnchorConfig(anchorConfig, sourceId) {
  if (typeof anchorConfig !== "string" || anchorConfig.trim() === "") {
    throw new Error("Anchor.toml is required to verify the deployed Payroll Program target.");
  }
  const provider = tomlSectionValues(anchorConfig, "provider");
  if (provider.cluster !== "Devnet") {
    throw new Error("Anchor.toml provider cluster must remain Devnet for this stage.");
  }
  const devnetPrograms = tomlSectionValues(anchorConfig, "programs.devnet");
  if (devnetPrograms.paylore_payroll !== sourceId) {
    throw new Error("Anchor.toml must map paylore_payroll to the existing Paylore Devnet Program ID.");
  }
  if (tomlSectionValues(anchorConfig, "programs.mainnet").paylore_payroll) {
    throw new Error("The Paylore Payroll Program must not be configured for Mainnet in this stage.");
  }
}

function rustType(value) {
  const compact = value.replace(/\s/g, "");
  if (compact === "String") return "string";
  if (compact === "Pubkey") return "pubkey";
  if (compact === "bool" || /^u(8|16|32|64|128)$/.test(compact)) return compact;
  if (compact === "ClaimStatus") return "defined:claimstatus";
  const array = compact.match(/^\[u8;(\d+)\]$/);
  if (array) return "array:u8:" + array[1];
  const vector = compact.match(/^Vec<\[u8;(\d+)\]>$/);
  if (vector) return "vec:array:u8:" + vector[1];
  throw new Error("IDL audit does not recognize Payroll Program Rust type \"" + value + "\".");
}

function findBalanced(source, openIndex, openChar, closeChar) {
  let depth = 0;
  for (let index = openIndex; index < source.length; index++) {
    if (source[index] === openChar) depth++;
    else if (source[index] === closeChar) {
      depth--;
      if (depth === 0) return index;
    }
  }
  throw new Error("Payroll Program source contains an unclosed declaration.");
}

function extractDeclarationBody(source, kind, name) {
  const declaration = new RegExp("pub\\s+" + kind + "\\s+" + name + "\\b[^{}]*\\{").exec(source);
  if (!declaration) throw new Error("Payroll Program source is missing " + kind + " \"" + name + "\".");
  const openIndex = declaration.index + declaration[0].lastIndexOf("{");
  return source.slice(openIndex + 1, findBalanced(source, openIndex, "{", "}"));
}

function rustStructFields(source, name) {
  const body = extractDeclarationBody(source, "struct", name);
  return [...body.matchAll(/^\s*pub\s+(\w+)\s*:\s*([^,\n]+),?\s*$/gm)]
    .map((match) => ({ name: match[1], type: match[2].trim() }));
}

function rustAccountNames(source, name) {
  return [...extractDeclarationBody(source, "struct", name).matchAll(/^\s*pub\s+(\w+)\s*:/gm)]
    .map((match) => match[1]);
}

function rustInstruction(source, name) {
  const declaration = new RegExp("pub\\s+fn\\s+" + name + "\\s*\\(").exec(source);
  if (!declaration) throw new Error("Payroll Program source is missing instruction \"" + name + "\".");
  const openIndex = declaration.index + declaration[0].lastIndexOf("(");
  const parameters = source.slice(openIndex + 1, findBalanced(source, openIndex, "(", ")"));
  const parts = parameters.split(",").map((part) => part.trim()).filter(Boolean);
  const context = parts.shift()?.match(/^ctx\s*:\s*Context\s*<\s*(\w+)\s*>$/);
  if (!context) throw new Error("Payroll Program instruction \"" + name + "\" has an unrecognized account context.");
  const args = parts.map((part) => {
    const separator = part.indexOf(":");
    if (separator < 1) throw new Error("Payroll Program instruction \"" + name + "\" has an unrecognized argument.");
    return { name: part.slice(0, separator).trim(), type: part.slice(separator + 1).trim() };
  });
  return { context: context[1], args };
}

function requiredInstruction(idlInstructions, expected, source) {
  const sourceInstruction = rustInstruction(source, expected.name);
  if (normalize(sourceInstruction.context) !== normalize(expected.context)) {
    throw new Error("Payroll Program instruction \"" + expected.name + "\" uses an unexpected account context.");
  }
  const sourceAccountNames = rustAccountNames(source, expected.context);
  if (JSON.stringify(sourceAccountNames.map(normalize)) !== JSON.stringify(expected.accounts.map(normalize))) {
    throw new Error(
      "Payroll Program source account order for \"" + expected.name + "\" differs from its approved ABI. " +
      "Expected [" + expected.accounts.join(", ") + "], received [" + sourceAccountNames.join(", ") + "]."
    );
  }
  if (JSON.stringify(sourceInstruction.args.map((arg) => normalize(arg.name))) !==
      JSON.stringify(expected.args.map((arg) => normalize(arg.name)))) {
    throw new Error("Payroll Program source argument order for \"" + expected.name + "\" differs from its approved ABI.");
  }
  for (let index = 0; index < expected.args.length; index++) {
    if (rustType(sourceInstruction.args[index].type) !== canonicalType(expected.args[index].type)) {
      throw new Error("Payroll Program source type for \"" + expected.name + "\" argument \"" +
        expected.args[index].name + "\" changed.");
    }
  }

  const actual = idlInstructions.find((item) => normalize(item.name) === normalize(expected.name));
  if (!actual) throw new Error("Generated IDL is missing instruction \"" + expected.name + "\".");
  if (!Array.isArray(actual.accounts)) {
    throw new Error("Generated IDL instruction \"" + expected.name + "\" has no flat account list.");
  }
  const actualAccounts = actual.accounts.map((item) => normalize(item.name));
  if (JSON.stringify(actualAccounts) !== JSON.stringify(expected.accounts.map(normalize))) {
    throw new Error(
      "Generated IDL account order for \"" + expected.name + "\" differs from the Payroll Program source. " +
      "Expected [" + expected.accounts.join(", ") + "], received [" + actual.accounts.map((item) => item.name).join(", ") + "]."
    );
  }
  const actualArgs = Array.isArray(actual.args) ? actual.args : [];
  if (JSON.stringify(actualArgs.map((item) => normalize(item.name))) !==
      JSON.stringify(expected.args.map((item) => normalize(item.name)))) {
    throw new Error("Generated IDL argument order for \"" + expected.name + "\" differs from the Payroll Program source.");
  }
  for (let index = 0; index < expected.args.length; index++) {
    if (canonicalType(actualArgs[index].type) !== canonicalType(expected.args[index].type)) {
      throw new Error(
        "Generated IDL type for \"" + expected.name + "\" argument \"" + expected.args[index].name +
        "\" differs from the approved ABI."
      );
    }
  }
}

const BYTE32 = { array: ["u8", 32] };
const EXPECTED_INSTRUCTIONS = [
  { name: "initialize_workspace", context: "InitializeWorkspace", accounts: ["authority", "workspace", "system_program"],
    args: [{ name: "workspace_id", type: "string" }, { name: "workspace_seed", type: BYTE32 }] },
  { name: "create_claim", context: "CreateClaim", accounts: ["authority", "contributor", "workspace", "claim", "system_program"],
    args: [
      { name: "claim_id", type: BYTE32 }, { name: "allocation_commitment", type: BYTE32 },
      { name: "amount_commitment", type: BYTE32 }, { name: "amount_commitment_leaf_index", type: "u32" },
      { name: "amount_commitment_proof", type: { vec: BYTE32 } }, { name: "escrow_token_account", type: "pubkey" }
    ] },
  { name: "configure_workspace_reserve", context: "ConfigureWorkspaceReserve",
    accounts: ["authority", "workspace", "reserve_state", "reserve_authority", "reserve_token_account", "mint", "system_program"], args: [] },
  { name: "mark_settlement_pending", context: "MarkSettlementPending",
    accounts: ["contributor", "workspace", "reserve_state", "reserve_authority", "reserve_token_account", "mint", "claim", "escrow_token_account", "destination_token_account", "instructions_sysvar", "amount_commitment_context"], args: [] },
  { name: "mark_claimed", context: "MarkClaimed",
    accounts: ["contributor", "workspace", "reserve_state", "reserve_authority", "reserve_token_account", "mint", "claim", "escrow_token_account", "destination_token_account", "instructions_sysvar", "amount_commitment_context"], args: [] },
  { name: "mark_claim_escrow_funded", context: "MarkClaimEscrowFunded",
    accounts: ["contributor", "workspace", "reserve_state", "reserve_authority", "reserve_token_account", "mint", "claim", "escrow_token_account", "instructions_sysvar", "amount_commitment_context"], args: [] },
  { name: "recover_claim", context: "RecoverClaim",
    accounts: ["contributor", "workspace", "reserve_state", "reserve_authority", "reserve_token_account", "mint", "claim", "escrow_token_account", "instructions_sysvar", "amount_commitment_context"],
    args: [{ name: "recovery_reason_commitment", type: BYTE32 }] },
  { name: "finalize_claimed", context: "FinalizeClaimed",
    accounts: ["contributor", "workspace", "reserve_state", "reserve_authority", "claim"], args: [] }
];

const CLAIM_STATE_LAYOUT = [
  ["workspace", "pubkey"], ["contributor", "pubkey"], ["claim_id", BYTE32],
  ["allocation_commitment", BYTE32], ["amount_commitment", BYTE32], ["escrow_token_account", "pubkey"],
  ["escrow_funded", "bool"], ["status", { defined: { name: "ClaimStatus" } }], ["bump", "u8"]
];
const CLAIM_STATUS_VARIANTS = ["Unclaimed", "Claimed", "Recovered", "SettlementPending"];

function auditClaimStateIdl(idl, source) {
  const sourceFields = rustStructFields(source, "ClaimState");
  if (JSON.stringify(sourceFields.map((field) => normalize(field.name))) !==
      JSON.stringify(CLAIM_STATE_LAYOUT.map(([name]) => normalize(name)))) {
    throw new Error("Payroll Program ClaimState source field order differs from the approved account layout.");
  }
  for (let index = 0; index < CLAIM_STATE_LAYOUT.length; index++) {
    if (rustType(sourceFields[index].type) !== canonicalType(CLAIM_STATE_LAYOUT[index][1])) {
      throw new Error("Payroll Program ClaimState field \"" + CLAIM_STATE_LAYOUT[index][0] + "\" changed type.");
    }
  }

  const claimStateImpl = source.match(/impl\s+ClaimState\s*\{([\s\S]*?)\}/);
  const stateSpace = claimStateImpl?.[1].match(/pub\s+const\s+SPACE\s*:\s*usize\s*=\s*([0-9\s+]+);/);
  const stateSpaceBytes = stateSpace?.[1].split("+").map((term) => Number(term.trim()));
  if (!stateSpaceBytes || stateSpaceBytes.some((value) => !Number.isSafeInteger(value)) ||
      stateSpaceBytes.reduce((sum, value) => sum + value, 0) !== 203) {
    throw new Error("Payroll Program ClaimState serialized size must remain 203 bytes for the current account decoder.");
  }

  const stateType = idl.types?.find((item) => normalize(item.name) === "claimstate");
  if (stateType?.type?.kind !== "struct" || !Array.isArray(stateType.type.fields)) {
    throw new Error("Generated IDL is missing the ClaimState account layout.");
  }
  const idlFields = stateType.type.fields;
  if (JSON.stringify(idlFields.map((field) => normalize(field.name))) !==
      JSON.stringify(CLAIM_STATE_LAYOUT.map(([name]) => normalize(name)))) {
    throw new Error("Generated IDL ClaimState field order differs from the approved account layout.");
  }
  for (let index = 0; index < CLAIM_STATE_LAYOUT.length; index++) {
    if (canonicalType(idlFields[index].type) !== canonicalType(CLAIM_STATE_LAYOUT[index][1])) {
      throw new Error("Generated IDL ClaimState field \"" + CLAIM_STATE_LAYOUT[index][0] + "\" changed type.");
    }
  }

  const sourceEnum = extractDeclarationBody(source, "enum", "ClaimStatus");
  const sourceVariants = [...sourceEnum.matchAll(/^\s*(\w+)\s*,?\s*$/gm)].map((match) => match[1]);
  if (JSON.stringify(sourceVariants.map(normalize)) !== JSON.stringify(CLAIM_STATUS_VARIANTS.map(normalize))) {
    throw new Error("Payroll Program ClaimStatus source variants differ from the approved state encoding.");
  }
  const statusType = idl.types?.find((item) => normalize(item.name) === "claimstatus");
  if (statusType?.type?.kind !== "enum" || !Array.isArray(statusType.type.variants) ||
      JSON.stringify(statusType.type.variants.map((variant) => normalize(variant.name))) !==
      JSON.stringify(CLAIM_STATUS_VARIANTS.map(normalize))) {
    throw new Error("Generated IDL ClaimStatus variant order differs from the approved on-chain state encoding.");
  }
}

/** Verifies ABI-critical instructions and serialized Claim PDA layout against Rust source and generated Anchor IDL. */
export function auditPayrollProgramIdl({ idl, source, anchorConfig }) {
  if (!idl || typeof idl !== "object" || !Array.isArray(idl.instructions)) {
    throw new Error("Generated Payroll Program IDL is malformed or has no instruction list.");
  }
  const sourceId = source.match(/declare_id!\(["']([^"']+)["']\)/)?.[1];
  if (!sourceId || sourceId !== EXPECTED_PAYLORE_PROGRAM_ID) {
    throw new Error("Payroll Program source declare_id does not match the approved existing Devnet Program ID.");
  }
  const idlId = idl.address ?? idl.metadata?.address;
  if (idlId !== sourceId) throw new Error("Generated Payroll Program IDL address does not match the source Program ID.");
  if (anchorConfig !== undefined) auditAnchorConfig(anchorConfig, sourceId);

  for (const expected of EXPECTED_INSTRUCTIONS) requiredInstruction(idl.instructions, expected, source);
  auditClaimStateIdl(idl, source);
  return {
    programId: sourceId,
    verifiedInstructions: EXPECTED_INSTRUCTIONS.map((item) => item.name),
    verifiedAccountLayouts: ["ClaimState", "ClaimStatus"]
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const idlPath = resolve(process.argv[2] ?? "target/idl/paylore_payroll.json");
  const sourcePath = resolve(process.argv[3] ?? "programs/payroll/src/lib.rs");
  const anchorConfigPath = resolve(process.argv[4] ?? "Anchor.toml");
  let idl;
  try {
    idl = JSON.parse(readFileSync(idlPath, "utf8"));
  } catch (error) {
    throw new Error("Unable to read generated IDL at " + idlPath + ". Run anchor build before this audit.", { cause: error });
  }
  const source = readFileSync(sourcePath, "utf8");
  const anchorConfig = readFileSync(anchorConfigPath, "utf8");
  const result = auditPayrollProgramIdl({ idl, source, anchorConfig });
  process.stdout.write(JSON.stringify({ status: "source_idl_parity_verified", ...result }, null, 2) + "\n");
}
