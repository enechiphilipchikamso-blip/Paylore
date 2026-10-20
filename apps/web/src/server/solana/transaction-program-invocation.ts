type Instruction = {
  programId?: unknown;
  programIdIndex?: unknown;
};

type TransactionLike = {
  transaction?: {
    message?: {
      accountKeys?: unknown;
      instructions?: unknown;
    };
  };
  meta?: {
    innerInstructions?: unknown;
  } | null;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function accountKeyAt(accountKeys: unknown, index: unknown): string | null {
  if (!Array.isArray(accountKeys) || !Number.isInteger(index)) return null;
  const entry = accountKeys[index as number];
  if (typeof entry === "string") return entry;
  return record(entry) && typeof entry.pubkey === "string"
    ? entry.pubkey
    : null;
}

function instructionProgramId(
  value: unknown,
  accountKeys: unknown
): string | null {
  if (!record(value)) return null;
  const instruction = value as Instruction;
  if (typeof instruction.programId === "string") {
    return instruction.programId;
  }
  return accountKeyAt(accountKeys, instruction.programIdIndex);
}

function containsProgramInvocation(
  instructions: unknown,
  accountKeys: unknown,
  expectedProgramId: string
): boolean {
  return (
    Array.isArray(instructions) &&
    instructions.some(
      (instruction) =>
        instructionProgramId(instruction, accountKeys) === expectedProgramId
    )
  );
}

export function transactionInvokesProgram(
  value: unknown,
  expectedProgramId: string
): boolean {
  if (!expectedProgramId || !record(value)) return false;
  const transaction = value as TransactionLike;
  const message = transaction.transaction?.message;
  if (!message) return false;
  const accountKeys = message.accountKeys;
  if (
    containsProgramInvocation(
      message.instructions,
      accountKeys,
      expectedProgramId
    )
  ) {
    return true;
  }

  if (!Array.isArray(transaction.meta?.innerInstructions)) return false;
  return transaction.meta.innerInstructions.some(
    (group) =>
      record(group) &&
      containsProgramInvocation(
        group.instructions,
        accountKeys,
        expectedProgramId
      )
  );
}
