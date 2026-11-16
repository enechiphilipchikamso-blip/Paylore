import {
  GAS_TANK_FUNDING_ALLOWED_EXTRA_PROGRAM_IDS,
  GAS_TANK_FUNDING_MAX_INSTRUCTIONS,
  SYSTEM_PROGRAM_ID
} from "../components/workspace/gas-tank-funding-programs";

type ParsedTransfer = {
  transaction?: unknown;
  meta?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object");
}

export function inspectGasTankFundingTransaction(
  value: ParsedTransfer | null,
  input: {
    payer: string;
    destination: string;
  }
):
  | { status: "pending" }
  | { status: "invalid" }
  | { status: "confirmed"; lamports: string } {
  if (!value) return { status: "pending" };
  if (!isRecord(value.meta) || value.meta.err !== null) {
    return { status: "invalid" };
  }
  if (!isRecord(value.transaction)) return { status: "invalid" };
  const message = value.transaction.message;
  if (!isRecord(message)) return { status: "invalid" };
  const keys = message.accountKeys;
  const instructions = message.instructions;
  if (!Array.isArray(keys) || !Array.isArray(instructions) ||
      instructions.length === 0 ||
      instructions.length > GAS_TANK_FUNDING_MAX_INSTRUCTIONS) {
    return { status: "invalid" };
  }
  // The administrator wallet must be the only signer.
  const signers = keys.filter(
    (entry) => isRecord(entry) && entry.signer === true
  );
  if (
    signers.length !== 1 ||
    !isRecord(signers[0]) ||
    signers[0].pubkey !== input.payer
  ) {
    return { status: "invalid" };
  }

  // Exactly one System Program transfer. Wallets may add priority-fee or guard
  // instructions around it; those are accepted only from allowlisted programs.
  let transfer: Record<string, unknown> | null = null;
  for (const instruction of instructions) {
    if (!isRecord(instruction)) return { status: "invalid" };
    if (
      instruction.program === "system" ||
      instruction.programId === SYSTEM_PROGRAM_ID
    ) {
      if (
        transfer !== null ||
        !isRecord(instruction.parsed) ||
        instruction.parsed.type !== "transfer" ||
        !isRecord(instruction.parsed.info)
      ) {
        return { status: "invalid" };
      }
      transfer = instruction.parsed.info;
      continue;
    }
    if (
      typeof instruction.programId !== "string" ||
      !GAS_TANK_FUNDING_ALLOWED_EXTRA_PROGRAM_IDS.has(instruction.programId)
    ) {
      return { status: "invalid" };
    }
  }
  if (transfer === null) return { status: "invalid" };
  const info = transfer;
  if (
    info.source !== input.payer ||
    info.destination !== input.destination ||
    (typeof info.lamports !== "string" &&
      typeof info.lamports !== "number")
  ) {
    return { status: "invalid" };
  }
  if (
    typeof info.lamports === "number" &&
    !Number.isSafeInteger(info.lamports)
  ) {
    return { status: "invalid" };
  }
  try {
    const amount = BigInt(info.lamports);
    if (amount <= 0n || amount >= (1n << 64n)) {
      return { status: "invalid" };
    }
    return { status: "confirmed", lamports: amount.toString() };
  } catch {
    return { status: "invalid" };
  }
}
