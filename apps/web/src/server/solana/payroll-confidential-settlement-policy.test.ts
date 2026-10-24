import { describe, expect, it } from "vitest";
import { address, singleInstructionPlan, type Instruction } from "@solana/kit";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS } from "@solana-program/zk-elgamal-proof";
import { bindSettlementPendingStateToConfidentialTransfer, getProofContextAddresses, isExpectedConfidentialTransfer, matchesExactConfidentialDebit } from "./payroll-confidential-settlement-policy";

const source = address("So11111111111111111111111111111111111111112");
const mint = address("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
const destination = address("11111111111111111111111111111111");
const other = address("4zYM9ZjwbAz9jxQ2C69Z83n1s4wceCPk7VzDLKoUnT93");
function ix(program: string, data: number[], accounts: string[] = []): Instruction {
  return { programAddress: address(program), data: Uint8Array.from(data), accounts: accounts.map((value) => ({ address: address(value), role: 0 })) };
}
describe("confidential settlement instruction binding", () => {
  it("treats only finalized signatures as authoritative", async () => {
    const { classifyTransactionFinality } = await import("./payroll-confidential-settlement-policy");
    expect(classifyTransactionFinality(null)).toBe("pending");
    expect(classifyTransactionFinality({ err: { InstructionError: [0, "Custom"] }, confirmationStatus: "processed" })).toBe("pending");
    expect(classifyTransactionFinality({ err: { InstructionError: [0, "Custom"] }, confirmationStatus: "confirmed" })).toBe("pending");
    expect(classifyTransactionFinality({ err: null, confirmationStatus: "confirmed" })).toBe("pending");
    expect(classifyTransactionFinality({ err: null, confirmationStatus: "finalized" })).toBe("finalized");
    expect(classifyTransactionFinality({ err: { InstructionError: [0, "Custom"] }, confirmationStatus: "finalized" })).toBe("failed");
  });

  const transfer = ix(TOKEN_2022_PROGRAM_ADDRESS, [27, 7], [source, mint, destination]);
  const expected = { source, mint, destination };
  it("rejects a mismatched transfer source, mint, destination, program and variant", () => {
    expect(isExpectedConfidentialTransfer(transfer, expected)).toBe(true);
    expect(isExpectedConfidentialTransfer(transfer, { ...expected, source: destination })).toBe(false);
    expect(isExpectedConfidentialTransfer(transfer, { ...expected, mint: source })).toBe(false);
    expect(isExpectedConfidentialTransfer(transfer, { ...expected, destination: source })).toBe(false);
    expect(isExpectedConfidentialTransfer(ix(other, [27, 7], [source, mint, destination]), expected)).toBe(false);
    expect(isExpectedConfidentialTransfer(ix(TOKEN_2022_PROGRAM_ADDRESS, [27, 6], [source, mint, destination]), expected)).toBe(false);
  });
  it("binds the settlement-pending transition to the exact transfer as an indivisible stage", () => {
    const setup = ix(other, [1]), cleanup = ix(other, [2]), mark = ix(other, [3]);
    const plan = { kind: "sequential" as const, planType: "instructionPlan" as const, divisible: true,
      plans: [singleInstructionPlan(setup), singleInstructionPlan(transfer), singleInstructionPlan(cleanup)] };
    const bound = bindSettlementPendingStateToConfidentialTransfer(plan, mark, expected);
    expect(bound.kind).toBe("sequential");
    if (bound.kind !== "sequential" || bound.plans[1]?.kind !== "sequential") return;
    expect(bound.plans[0]).toEqual(singleInstructionPlan(setup));
    expect(bound.plans[1].divisible).toBe(false);
    expect(bound.plans[1].plans).toHaveLength(2);
    if (bound.plans[1].kind !== "sequential") return;
    expect(bound.plans[1].plans[0]).toEqual(singleInstructionPlan(transfer));
    expect(bound.plans[1].plans[1]).toEqual(singleInstructionPlan(mark));
    expect(bound.plans[2]).toEqual(singleInstructionPlan(cleanup));
  });

  it("rejects a transfer plan whose phase order or transfer accounts differ", () => {
    const setup = ix(other, [1]), cleanup = ix(other, [2]), mark = ix(other, [3]);
    const wrongTransfer = ix(TOKEN_2022_PROGRAM_ADDRESS, [27, 7], [source, mint, other]);
    const wrongOrder = {
      kind: "sequential" as const, planType: "instructionPlan" as const, divisible: true,
      plans: [singleInstructionPlan(setup), singleInstructionPlan(cleanup), singleInstructionPlan(wrongTransfer)]
    };
    expect(() => bindSettlementPendingStateToConfidentialTransfer(wrongOrder, mark, expected))
      .toThrow("plan shape has changed");
    const wrongAccounts = {
      kind: "sequential" as const, planType: "instructionPlan" as const, divisible: true,
      plans: [singleInstructionPlan(setup), singleInstructionPlan(wrongTransfer), singleInstructionPlan(cleanup)]
    };
    expect(() => bindSettlementPendingStateToConfidentialTransfer(wrongAccounts, mark, expected))
      .toThrow("plan shape has changed");
  });
  it("extracts only ZK proof-context close instructions and deduplicates addresses", () => {
    const contextA = address("ComputeBudget111111111111111111111111111111");
    const contextB = address("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");
    const plan = { kind: "parallel" as const, planType: "instructionPlan" as const, divisible: true,
      plans: [
        singleInstructionPlan(ix(ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS, [1], [contextA, source, destination])),
        singleInstructionPlan(ix(ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS, [1], [contextB, source, destination])),
        singleInstructionPlan(ix(other, [1], [source, destination])),
        singleInstructionPlan(ix(ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS, [1], [contextA, source, destination]))
      ] };
    expect(getProofContextAddresses(plan)).toEqual([contextA, contextB]);
  });
});

describe("confidential settlement amount reconciliation", () => {
  it("accepts only the exact positive integer reserve debit", () => {
    expect(matchesExactConfidentialDebit({
      amountBaseUnits: "1250000",
      sourceAvailableBefore: "5000000",
      sourceAvailableAfter: "3750000"
    })).toBe(true);
  });

  it.each([
    ["wrong amount", { amountBaseUnits: "1250000", sourceAvailableBefore: "5000000", sourceAvailableAfter: "4000000" }],
    ["balance increased", { amountBaseUnits: "100", sourceAvailableBefore: "1000", sourceAvailableAfter: "1100" }],
    ["zero amount", { amountBaseUnits: "0", sourceAvailableBefore: "1000", sourceAvailableAfter: "1000" }],
    ["negative syntax", { amountBaseUnits: "-1", sourceAvailableBefore: "1000", sourceAvailableAfter: "999" }],
    ["non-integer amount", { amountBaseUnits: "1.5", sourceAvailableBefore: "1000", sourceAvailableAfter: "998" }],
    ["non-canonical balance", { amountBaseUnits: "1", sourceAvailableBefore: "010", sourceAvailableAfter: "9" }]
  ])("rejects %s", (_label, input) => {
    expect(matchesExactConfidentialDebit(input)).toBe(false);
  });
});
