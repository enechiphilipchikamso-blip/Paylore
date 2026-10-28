import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  findSupportedPayrollEvent,
  inspectCanonicalTransactionEvent,
  scanCanonicalSignaturePage,
  type CanonicalSignatureInfo,
  type CanonicalTransactionLike
} from "./canonical-event-scanner";

const PROGRAM_ID = "PaylorePayrollProgram111111111111111111111111";
const SYSTEM_PROGRAM_ID = "11111111111111111111111111111111";
const WATCHED_ACCOUNT = "WatchedAccount11111111111111111111111111111";
const OTHER_ACCOUNT = "OtherAccount11111111111111111111111111111111";
const GAS_TANK_ACCOUNT = "GasTankAccount111111111111111111111111111";
const SIGNER = "SignerWallet1111111111111111111111111111111";
const SIGNATURE = "1".repeat(64);

function base58(bytes: Uint8Array): string {
  const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  let n = 0n;
  for (const byte of bytes) n = (n << 8n) | BigInt(byte);
  let result = "";
  while (n) { result = alphabet[Number(n % 58n)] + result; n /= 58n; }
  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) leadingZeroes++;
  return "1".repeat(leadingZeroes) + result;
}

function instructionData(name: string, payload = new Uint8Array()): string {
  return base58(Buffer.concat([
    createHash("sha256").update(name).digest().subarray(0, 8),
    Buffer.from(payload)
  ]));
}

function accountKey(pubkey: string, signer = false) {
  return { pubkey, signer, writable: true };
}

function transaction(
  signature: string,
  slot: number,
  instructions: Array<Record<string, unknown>>,
  keys = [WATCHED_ACCOUNT, PROGRAM_ID]
): CanonicalTransactionLike {
  const instructionAccounts = instructions.flatMap((instruction) =>
    Array.isArray(instruction.accounts)
      ? instruction.accounts.filter((value): value is string => typeof value === "string")
      : []
  );
  const allKeys = [...new Set([...keys, ...instructionAccounts])];
  return {
    slot,
    meta: { err: null },
    transaction: {
      signatures: [signature],
      message: {
        accountKeys: allKeys.map((key) => accountKey(key, key === SIGNER)),
        instructions
      }
    }
  };
}

function payrollInstruction(name: string, payload: Uint8Array = new Uint8Array()) {
  return {
    programId: PROGRAM_ID,
    accounts: [WATCHED_ACCOUNT],
    data: instructionData("global:" + name, new Uint8Array(payload))
  };
}

describe("canonical event discovery and reconciliation input mapping", () => {
  it("scans finalized signatures and advances the high-water cursor over irrelevant transactions", async () => {
    const signature: CanonicalSignatureInfo = { signature: SIGNATURE, slot: 7 };
    const scan = await scanCanonicalSignaturePage({
      address: WATCHED_ACCOUNT,
      cursor: null,
      fetchSignatures: async (_address, options) => {
        expect(options).toMatchObject({ commitment: "finalized", limit: 25 });
        return [signature];
      },
      inspect: async (info, address) => inspectCanonicalTransactionEvent({
        signature: info,
        accountAddress: address,
        transaction: transaction(info.signature, info.slot, [{
          programId: PROGRAM_ID,
          accounts: [WATCHED_ACCOUNT],
          data: instructionData("global:unrecognized")
        }]),
        payrollProgramId: PROGRAM_ID,
        isGasTankAddress: async () => false
      })
    });
    expect(scan).toMatchObject({
      cursor: { address: WATCHED_ACCOUNT, highWaterSignature: SIGNATURE, backfillBeforeSignature: null },
      events: []
    });
  });

  it("enqueues a payroll event absent from provider delivery only after signature, slot, and watched account bind", async () => {
    const info = { signature: SIGNATURE, slot: 42 };
    const mapped = await inspectCanonicalTransactionEvent({
      signature: info,
      accountAddress: WATCHED_ACCOUNT,
      transaction: transaction(info.signature, info.slot, [
        payrollInstruction("create_claim", Buffer.concat([Buffer.alloc(32, 1), Buffer.alloc(32, 2)]))
      ]),
      payrollProgramId: PROGRAM_ID,
      isGasTankAddress: async () => false
    });

    expect(mapped).toEqual({
      ready: true,
      event: {
        provider: "canonical-rpc-scanner",
        providerEventId: SIGNATURE,
        transactionSignature: SIGNATURE,
        transactionSlot: "42",
        accountAddress: WATCHED_ACCOUNT,
        eventType: "payroll-create_claim",
        payload: {
          signature: SIGNATURE,
          slot: 42,
          type: "payroll-create_claim",
          sourceAddress: WATCHED_ACCOUNT
        },
        status: "received"
      }
    });
  });

  it.each([
    ["signature", (info: CanonicalSignatureInfo) => transaction("2".repeat(64), info.slot, [
      payrollInstruction("recover_claim", Buffer.alloc(32, 5))
    ])],
    ["slot", (info: CanonicalSignatureInfo) => transaction(info.signature, info.slot + 1, [
      payrollInstruction("recover_claim", Buffer.alloc(32, 5))
    ])],
    ["watched account", (info: CanonicalSignatureInfo) => transaction(info.signature, info.slot, [{
      programId: PROGRAM_ID,
      accounts: [OTHER_ACCOUNT],
      data: instructionData("global:recover_claim", Buffer.alloc(32, 5))
    }], [PROGRAM_ID, SIGNER])]
  ] as const)("does not advance past a transaction with a mismatched %s binding", async (_label, makeTransaction) => {
    const info = { signature: SIGNATURE, slot: 42 };
    const mapped = await inspectCanonicalTransactionEvent({
      signature: info,
      accountAddress: WATCHED_ACCOUNT,
      transaction: makeTransaction(info),
      payrollProgramId: PROGRAM_ID,
      isGasTankAddress: async () => false
    });
    expect(mapped).toEqual({ ready: false });
  });

  it("maps every supported Payroll Program transition to a deterministic event type", async () => {
    for (const name of ["create_claim", "finalize_claimed", "recover_claim"]) {
      const payload = name === "recover_claim" ? Buffer.alloc(32, 7)
        : name === "create_claim" ? Buffer.alloc(64, 4) : new Uint8Array();
      const info = { signature: SIGNATURE, slot: 43 };
      const mapped = await inspectCanonicalTransactionEvent({
        signature: info,
        accountAddress: WATCHED_ACCOUNT,
        transaction: transaction(info.signature, info.slot, [payrollInstruction(name, payload)]),
        payrollProgramId: PROGRAM_ID,
        isGasTankAddress: async () => false
      });
      expect(mapped.ready).toBe(true);
      expect(mapped).toMatchObject({
        event: {
          eventType: "payroll-" + name,
          transactionSignature: SIGNATURE,
          transactionSlot: "43"
        }
      });
    }
  });

  it("discovers Gas Tank funding only from a signed positive system transfer into the configured Gas Tank", async () => {
    const info = { signature: SIGNATURE, slot: 51 };
    const canonical = transaction(info.signature, info.slot, [{
      programId: SYSTEM_PROGRAM_ID,
      program: "system",
      accounts: [SIGNER, GAS_TANK_ACCOUNT],
      parsed: {
        type: "transfer",
        info: { source: SIGNER, destination: GAS_TANK_ACCOUNT, lamports: "3000000" }
      }
    }], [WATCHED_ACCOUNT, SIGNER, GAS_TANK_ACCOUNT]);
    const mapped = await inspectCanonicalTransactionEvent({
      signature: info,
      accountAddress: WATCHED_ACCOUNT,
      transaction: canonical,
      payrollProgramId: PROGRAM_ID,
      isGasTankAddress: async (destination) => destination === GAS_TANK_ACCOUNT
    });
    expect(mapped).toMatchObject({
      ready: true,
      event: {
        eventType: "gas-tank-funding",
        payload: { sourceAddress: SIGNER }
      }
    });

    const unsigned = {
      ...canonical,
      transaction: {
        ...canonical.transaction!,
        message: {
          ...canonical.transaction!.message!,
          accountKeys: (canonical.transaction!.message!.accountKeys as Array<Record<string, unknown> | string> | undefined)?.map((key) =>
            key && typeof key === "object" && "pubkey" in key && key.pubkey === SIGNER
              ? { ...key, signer: false }
              : key
          )
        }
      }
    } as CanonicalTransactionLike;
    const unsafe = await inspectCanonicalTransactionEvent({
      signature: info,
      accountAddress: WATCHED_ACCOUNT,
      transaction: unsigned,
      payrollProgramId: PROGRAM_ID,
      isGasTankAddress: async () => true
    });
    expect(unsafe).toEqual({ ready: true, event: null });
  });

  it("enqueues an application-backed subscription payment attempt without a Helius delivery", async () => {
    const info = { signature: SIGNATURE, slot: 60 };
    await expect(inspectCanonicalTransactionEvent({
      signature: info,
      accountAddress: WATCHED_ACCOUNT,
      transaction: null,
      subscriptionPaymentAttemptFound: true,
      isGasTankAddress: async () => false
    })).resolves.toMatchObject({
      ready: true,
      event: {
        provider: "canonical-rpc-scanner",
        eventType: "subscription-payment-attempt",
        transactionSignature: SIGNATURE
      }
    });
  });

  it("continues bounded historical backfill without moving the established high-water signature", async () => {
    const cursor = {
      address: WATCHED_ACCOUNT,
      highWaterSignature: "high-water",
      backfillBeforeSignature: "oldest-seen",
      backfillUntilSignature: "previous-high-water"
    };
    let requested: unknown;
    const result = await scanCanonicalSignaturePage({
      address: WATCHED_ACCOUNT,
      cursor,
      fetchSignatures: async (_address, options) => {
        requested = options;
        return Array.from({ length: 25 }, (_, index) => ({ signature: "page-" + index, slot: index + 1 }));
      },
      inspect: async () => ({ ready: true, event: null })
    });
    expect(requested).toMatchObject({
      before: "oldest-seen", until: "previous-high-water", commitment: "finalized", limit: 25
    });
    expect(result?.cursor).toMatchObject({
      highWaterSignature: "high-water",
      backfillBeforeSignature: "page-24",
      backfillUntilSignature: "previous-high-water"
    });
  });

  it("does not advance the cursor when any signature is not inspectable", async () => {
    const result = await scanCanonicalSignaturePage({
      address: WATCHED_ACCOUNT,
      cursor: {
        address: WATCHED_ACCOUNT,
        highWaterSignature: "previous",
        backfillBeforeSignature: null,
        backfillUntilSignature: null
      },
      fetchSignatures: async () => [{ signature: SIGNATURE, slot: 8 }],
      inspect: async () => ({ ready: false })
    });
    expect(result).toBeNull();
  });

  it("maps only configured Payroll Program instruction discriminators", () => {
    const data = instructionData("global:recover_claim", Buffer.alloc(32, 9));
    expect(findSupportedPayrollEvent({
      transaction: { message: { instructions: [{ programId: PROGRAM_ID, data }] }
      }
    }, PROGRAM_ID)).toBe("recover_claim");
    expect(findSupportedPayrollEvent({
      transaction: { message: { instructions: [{ programId: "other-program", data }] }
      }
    }, PROGRAM_ID)).toBeNull();
  });

  it("does not collapse different Payroll Program outcomes into one event", () => {
    const data = instructionData("global:create_claim", Buffer.alloc(64, 1));
    const finalized = instructionData("global:finalize_claimed");
    expect(findSupportedPayrollEvent({
      transaction: { message: { instructions: [
        { programId: PROGRAM_ID, data },
        { programId: PROGRAM_ID, data: finalized }
      ] } }
    }, PROGRAM_ID)).toBeNull();
  });
});
