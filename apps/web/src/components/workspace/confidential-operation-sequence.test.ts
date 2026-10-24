import { describe, expect, it } from "vitest";
import {
  advanceConfidentialSequence,
  assertConfidentialAccountAutoApproval,
  assertConfidentialStepAllowed,
  assertExactConfidentialWithdrawal,
  createConfidentialSequenceProgress
} from "./confidential-operation-sequence";

describe("confidential operation sequencing", () => {
  it("requires configuration before any reserve funding or transfer step", () => {
    const progress = createConfidentialSequenceProgress();
    expect(() => assertConfidentialStepAllowed(progress, "deposit")).toThrow("not allowed");
    expect(() => assertConfidentialStepAllowed(progress, "confidential_transfer")).toThrow("not allowed");
  });

  it("allows an already-funded reserve to proceed from configuration to proof setup", () => {
    let progress = createConfidentialSequenceProgress();
    progress = advanceConfidentialSequence(progress, "reserve_configure", "finalized");
    progress = advanceConfidentialSequence(progress, "proof_setup", "finalized");
    progress = advanceConfidentialSequence(progress, "confidential_transfer", "finalized");
    expect(progress.completed).toEqual(["reserve_configure", "proof_setup", "confidential_transfer"]);
  });

  it("requires pending balances to be applied before proof generation when present", () => {
    let progress = advanceConfidentialSequence(
      createConfidentialSequenceProgress(), "reserve_configure", "finalized"
    );
    progress = advanceConfidentialSequence(progress, "pending_apply_before_deposit", "finalized");
    expect(() => advanceConfidentialSequence(progress, "proof_setup", "finalized")).not.toThrow();
    expect(() => advanceConfidentialSequence(progress, "deposit", "finalized")).not.toThrow();
  });

  it("requires deposited funds to be applied before proof setup", () => {
    let progress = advanceConfidentialSequence(
      createConfidentialSequenceProgress(), "reserve_configure", "finalized"
    );
    progress = advanceConfidentialSequence(progress, "deposit", "finalized");
    expect(() => assertConfidentialStepAllowed(progress, "proof_setup")).toThrow("not allowed");
    progress = advanceConfidentialSequence(progress, "pending_apply_after_deposit", "finalized");
    progress = advanceConfidentialSequence(progress, "proof_setup", "finalized");
    expect(progress.completed.at(-1)).toBe("proof_setup");
  });

  it.each(["pending", "failed"] as const)(
    "does not advance after a %s transaction result",
    (finality) => {
      const progress = advanceConfidentialSequence(
        createConfidentialSequenceProgress(), "reserve_configure", "finalized"
      );
      expect(() => advanceConfidentialSequence(progress, "deposit", finality)).toThrow(finality);
      expect(progress.completed).toEqual(["reserve_configure"]);
    }
  );

  it("rejects duplicate or out-of-order transfer transitions", () => {
    let progress = createConfidentialSequenceProgress();
    progress = advanceConfidentialSequence(progress, "reserve_configure", "finalized");
    progress = advanceConfidentialSequence(progress, "proof_setup", "finalized");
    progress = advanceConfidentialSequence(progress, "confidential_transfer", "finalized");
    expect(() => advanceConfidentialSequence(progress, "confidential_transfer", "finalized")).toThrow("not allowed");
  });

  it.each([
    ["reserve_configure", []],
    ["pending_apply_before_deposit", ["reserve_configure"]],
    ["deposit", ["reserve_configure"]],
    ["pending_apply_after_deposit", ["reserve_configure", "deposit"]],
    ["proof_setup", ["reserve_configure"]],
    ["confidential_transfer", ["reserve_configure", "proof_setup"]]
  ] as const)("does not advance %s when its transaction is pending or failed", (step, prefix) => {
    for (const finality of ["pending", "failed"] as const) {
      let progress = createConfidentialSequenceProgress();
      for (const completed of prefix) {
        progress = advanceConfidentialSequence(progress, completed, "finalized");
      }
      const before = [...progress.completed];
      expect(() => advanceConfidentialSequence(progress, step, finality)).toThrow(finality);
      expect(progress.completed).toEqual(before);
    }
  });

  it("requires mint auto-approval instead of pretending the owner can approve itself", () => {
    expect(() => assertConfidentialAccountAutoApproval({
      confidentialTransferExtensionPresent: true, autoApproveNewAccounts: false
    })).toThrow("requires approval by its confidential-transfer mint authority");
    expect(() => assertConfidentialAccountAutoApproval({
      confidentialTransferExtensionPresent: false, autoApproveNewAccounts: true
    })).toThrow("does not support confidential transfers");
    expect(() => assertConfidentialAccountAutoApproval({
      confidentialTransferExtensionPresent: true, autoApproveNewAccounts: true
    })).not.toThrow();
  });

  it("accepts only exact confidential withdrawal debit and public credit", () => {
    const valid = {
      amountBaseUnits: 250n,
      availableBefore: 1_000n,
      availableAfter: 750n,
      publicBefore: 100n,
      publicAfter: 350n,
      transactionSignature: "signature"
    };
    expect(() => assertExactConfidentialWithdrawal(valid)).not.toThrow();
    expect(() => assertExactConfidentialWithdrawal({ ...valid, publicAfter: 349n }))
      .toThrow("Do not submit a duplicate withdrawal");
    expect(() => assertExactConfidentialWithdrawal({ ...valid, availableAfter: 751n }))
      .toThrow("Do not submit a duplicate withdrawal");
  });
});
