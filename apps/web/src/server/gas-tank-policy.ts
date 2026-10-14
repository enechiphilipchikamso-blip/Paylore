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
      instructions.length !== 1) {
    return { status: "invalid" };
  }
  const hasPayerSigner = keys.some(
    (entry) =>
      isRecord(entry) &&
      entry.pubkey === input.payer &&
      entry.signer === true
  );
  if (!hasPayerSigner) return { status: "invalid" };

  const instruction = instructions[0];
  if (
    !isRecord(instruction) ||
    instruction.program !== "system" ||
    !isRecord(instruction.parsed) ||
    instruction.parsed.type !== "transfer" ||
    !isRecord(instruction.parsed.info)
  ) {
    return { status: "invalid" };
  }
  const info = instruction.parsed.info;
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
