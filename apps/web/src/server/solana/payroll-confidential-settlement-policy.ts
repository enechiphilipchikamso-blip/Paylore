import { nonDivisibleSequentialInstructionPlan, type Instruction, type InstructionPlan } from "@solana/kit";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS } from "@solana-program/zk-elgamal-proof";

export function isExpectedConfidentialTransfer(
  instruction: Instruction,
  expected: { source: string; mint: string; destination: string }
): boolean {
  const accounts = instruction.accounts ?? [];
  return instruction.programAddress === TOKEN_2022_PROGRAM_ADDRESS &&
    instruction.data.length >= 2 && instruction.data[0] === 27 && instruction.data[1] === 7 &&
    accounts.length >= 3 && accounts[0]?.address === expected.source &&
    accounts[1]?.address === expected.mint && accounts[2]?.address === expected.destination;
}

export function getProofContextAddresses(plan: InstructionPlan): string[] {
  const addresses: string[] = [];
  const visit = (node: unknown): void => {
    if (node === null || typeof node !== "object" || Array.isArray(node)) return;
    const value = node as Record<string, unknown>;
    const rawInstruction = value.instruction;
    if (rawInstruction !== null && typeof rawInstruction === "object" && !Array.isArray(rawInstruction)) {
      const instruction = rawInstruction as Record<string, unknown>;
      const accounts = Array.isArray(instruction.accounts) ? instruction.accounts : [];
      const first = accounts[0];
      const firstAddress = first !== null && typeof first === "object"
        ? (first as Record<string, unknown>).address
        : undefined;
      if (instruction.programAddress === ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS && typeof firstAddress === "string") {
        addresses.push(firstAddress);
      }
    }
    if (Array.isArray(value.plans)) value.plans.forEach(visit);
  };
  visit(plan);
  return [...new Set(addresses)];
}

/** Makes the on-chain Claim-PDA transition indivisible with its confidential transfer. */
export function bindAmountBoundClaimedStateToConfidentialTransfer(
  plan: InstructionPlan,
  markSettlementPending: Instruction,
  expected: { source: string; mint: string; destination: string }
): InstructionPlan {
  if (plan.kind !== "sequential" || plan.plans.length !== 3 ||
      plan.plans[1]?.kind !== "single" ||
      !isExpectedConfidentialTransfer(plan.plans[1].instruction, expected)) {
    throw new Error("The official Token-2022 confidential transfer plan shape has changed.");
  }
  return {
    ...plan,
    plans: [plan.plans[0]!, nonDivisibleSequentialInstructionPlan([plan.plans[1].instruction, markSettlementPending]), plan.plans[2]!]
  };
}

export type TransactionFinality = "finalized" | "failed" | "pending";

/** Only finalized outcomes are authoritative; processed failures can disappear on a fork. */
export function classifyTransactionFinality(
  status: { err?: unknown; confirmationStatus?: string | null } | null | undefined
): TransactionFinality {
  if (!status || status.confirmationStatus !== "finalized") return "pending";
  return status.err === null || status.err === undefined ? "finalized" : "failed";
}

/** Confirms the decrypted reserve debit equals the server-approved integer USDC amount. */
export function matchesExactConfidentialDebit(input: {
  amountBaseUnits: string;
  sourceAvailableBefore: string;
  sourceAvailableAfter: string;
}): boolean {
  if (!/^[1-9][0-9]*$/.test(input.amountBaseUnits) ||
      !/^(0|[1-9][0-9]*)$/.test(input.sourceAvailableBefore) ||
      !/^(0|[1-9][0-9]*)$/.test(input.sourceAvailableAfter)) {
    return false;
  }
  const amount = BigInt(input.amountBaseUnits);
  const before = BigInt(input.sourceAvailableBefore);
  const after = BigInt(input.sourceAvailableAfter);
  return before >= after && before - after === amount;
}
