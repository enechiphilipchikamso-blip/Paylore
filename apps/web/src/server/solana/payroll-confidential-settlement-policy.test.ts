import { describe, expect, it } from "vitest";
import { address, getAddressEncoder, singleInstructionPlan, type Instruction } from "@solana/kit";
import { TOKEN_2022_PROGRAM_ADDRESS } from "@solana-program/token-2022";
import { ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS } from "@solana-program/zk-elgamal-proof";
import {
  bindSettlementPendingStateToConfidentialTransfer, classifyProofContextAccount, getProofContextAddresses, isExpectedConfidentialTransfer,
  isOrphanedAttempt, matchesConfiguredReserveState, matchesExactConfidentialDebit, ORPHANED_ATTEMPT_AFTER_MS,
  pickContextStateAuthority, proofContextsReadyForTransfer, readContextStateAuthority
} from "./payroll-confidential-settlement-policy";

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

describe("orphaned funding attempts", () => {
  const now = Date.parse("2026-11-20T12:00:00Z");

  it("treats only an attempt older than the threshold as orphaned", () => {
    expect(isOrphanedAttempt(new Date(now - ORPHANED_ATTEMPT_AFTER_MS - 1), now)).toBe(true);
    expect(isOrphanedAttempt(new Date(now - ORPHANED_ATTEMPT_AFTER_MS), now)).toBe(false);
    expect(isOrphanedAttempt(new Date(now - 1_000), now)).toBe(false);
  });

  it("never treats a missing timestamp as stale", () => {
    expect(isOrphanedAttempt(null, now)).toBe(false);
    expect(isOrphanedAttempt(undefined, now)).toBe(false);
  });
});

describe("proof context authority", () => {
  const gasTank = new Uint8Array(32).fill(5);
  const reserve = new Uint8Array(32).fill(9);
  const gasSigner = { address: "gas-tank" };
  const reserveSigner = { address: "reserve" };
  const candidates = [
    { signer: gasSigner, addressBytes: gasTank },
    { signer: reserveSigner, addressBytes: reserve }
  ];
  const account = (authority: Uint8Array) => {
    const data = new Uint8Array(33);
    data.set(authority);
    return data;
  };

  it("reads the authority from the first 32 bytes of the context account", () => {
    expect(Array.from(readContextStateAuthority(account(gasTank))!)).toEqual(Array.from(gasTank));
  });

  it.each([[null], [undefined], ["text"], [new Uint8Array(32)], [new Uint8Array(0)]])(
    "rejects context data that cannot hold an authority and a proof (%#)",
    (data) => expect(readContextStateAuthority(data)).toBeNull()
  );

  it("picks the signer that is the recorded authority, whichever account paid", () => {
    expect(pickContextStateAuthority(account(gasTank), candidates)).toBe(gasSigner);
    expect(pickContextStateAuthority(account(reserve), candidates)).toBe(reserveSigner);
  });

  it("picks nobody when no signer is the authority", () => {
    expect(pickContextStateAuthority(account(new Uint8Array(32).fill(1)), candidates)).toBeNull();
    expect(pickContextStateAuthority(null, candidates)).toBeNull();
  });
});

describe("configured reserve state", () => {
  const expected = {
    workspace: new Uint8Array(32).fill(1),
    reserveAuthority: new Uint8Array(32).fill(2),
    reserveToken: new Uint8Array(32).fill(3),
    mint: new Uint8Array(32).fill(4)
  };
  const state = (overrides: Partial<typeof expected> = {}) => {
    const fields = { ...expected, ...overrides };
    const data = new Uint8Array(8 + 32 * 4 + 1);
    data.set(fields.workspace, 8);
    data.set(fields.reserveAuthority, 40);
    data.set(fields.reserveToken, 72);
    data.set(fields.mint, 104);
    return data;
  };

  it("matches the exact configured workspace, authority, token account and mint", () => {
    expect(matchesConfiguredReserveState(state(), expected)).toBe(true);
  });

  it.each(["workspace", "reserveAuthority", "reserveToken", "mint"] as const)(
    "does not match when the %s differs",
    (field) => expect(matchesConfiguredReserveState(state({ [field]: new Uint8Array(32).fill(99) }), expected)).toBe(false)
  );

  it("does not match missing or truncated account data", () => {
    expect(matchesConfiguredReserveState(null, expected)).toBe(false);
    expect(matchesConfiguredReserveState(state().subarray(0, 100), expected)).toBe(false);
  });
});

describe("proof context account classification", () => {
  const proofProgram = ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS;
  const gasTank = { address: "Vote111111111111111111111111111111111111111" };
  const reserve = { address: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" };
  const encode = (value: string) => new Uint8Array(getAddressEncoder().encode(address(value)));
  const candidates = [gasTank, reserve].map((signer) => ({ signer, addressBytes: encode(signer.address) }));
  const withAuthority = (value: string, length = 297) => {
    const data = new Uint8Array(length);
    data.set(encode(value));
    data[32] = 1;
    return data;
  };

  it("is absent when the account does not exist", () => {
    expect(classifyProofContextAccount({ exists: false }, proofProgram, candidates)).toEqual({ kind: "absent" });
  });

  it("is closable when the Gas Tank is the recorded authority", () => {
    expect(classifyProofContextAccount(
      { exists: true, owner: proofProgram, data: withAuthority(gasTank.address) }, proofProgram, candidates
    )).toEqual({ kind: "closable", authority: gasTank });
  });

  it("is closable by the reserve when the reserve is the authority", () => {
    expect(classifyProofContextAccount(
      { exists: true, owner: proofProgram, data: withAuthority(reserve.address) }, proofProgram, candidates
    )).toEqual({ kind: "closable", authority: reserve });
  });

  it("is uninitialized when the account is all zero, as verify-before-create left it", () => {
    // The stuck production account: 297 zero bytes owned by the proof program. Its authority is
    // the zero address, which no signer can ever match, so it can never be closed.
    expect(classifyProofContextAccount(
      { exists: true, owner: proofProgram, data: new Uint8Array(297) }, proofProgram, candidates
    )).toEqual({ kind: "uninitialized" });
  });

  it("is foreign when another program owns the account", () => {
    expect(classifyProofContextAccount(
      { exists: true, owner: other, data: withAuthority(gasTank.address) }, proofProgram, candidates
    )).toEqual({ kind: "foreign" });
  });

  it("is unclosable when initialised for an authority we do not hold", () => {
    expect(classifyProofContextAccount(
      { exists: true, owner: proofProgram, data: withAuthority(other) }, proofProgram, candidates
    )).toEqual({ kind: "unclosable" });
  });

  it("is unclosable when the data is too short to carry an authority", () => {
    expect(classifyProofContextAccount(
      { exists: true, owner: proofProgram, data: new Uint8Array(8) }, proofProgram, candidates
    )).toEqual({ kind: "unclosable" });
    expect(classifyProofContextAccount({ exists: true, owner: proofProgram }, proofProgram, candidates))
      .toEqual({ kind: "unclosable" });
  });

  describe("readiness for the confidential transfer", () => {
    const closable = { kind: "closable" as const, authority: gasTank };

    it("is ready only when every context is initialised and owned by the Gas Tank", () => {
      expect(proofContextsReadyForTransfer([closable, closable, closable], gasTank.address, 3)).toBe(true);
    });

    it.each([
      ["an all-zero context", { kind: "uninitialized" as const }],
      ["a missing context", { kind: "absent" as const }],
      ["a foreign context", { kind: "foreign" as const }],
      ["an unclosable context", { kind: "unclosable" as const }],
      ["a context owned by the reserve instead of the Gas Tank", { kind: "closable" as const, authority: reserve }]
    ])("is not ready with %s", (_label, state) => {
      expect(proofContextsReadyForTransfer([closable, closable, state], gasTank.address, 3)).toBe(false);
    });

    it("is not ready when a context was not read at all", () => {
      expect(proofContextsReadyForTransfer([closable, closable], gasTank.address, 3)).toBe(false);
      expect(proofContextsReadyForTransfer([], gasTank.address, 0)).toBe(true);
    });
  });
});
