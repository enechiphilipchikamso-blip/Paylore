import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generateReserveKeypair,
  openGasTankKey,
  openReserveKey,
  rewrapGasTankKey,
  rewrapReserveKey,
  sealGasTankKey,
  sealReserveKey
} from "./reserve-crypto-policy";

describe("envelope-key rewrapping", () => {
  it("rewraps reserve data and recovery backup under a new envelope key", () => {
    const currentEnvelopeKey = randomBytes(32).toString("base64");
    const nextEnvelopeKey = randomBytes(32).toString("base64");
    const keypair = generateReserveKeypair();
    const sealed = sealReserveKey(
      "workspace-a",
      keypair.address,
      keypair.privateKey,
      currentEnvelopeKey
    );

    const rewrapped = rewrapReserveKey(
      "workspace-a",
      sealed,
      currentEnvelopeKey,
      nextEnvelopeKey
    );

    expect(rewrapped.encryptedPrivateKey).not.toBe(
      sealed.encryptedPrivateKey
    );
    const opened = openReserveKey(
      "workspace-a",
      rewrapped,
      nextEnvelopeKey
    );
    expect(opened).toEqual(keypair.privateKey);
    opened.fill(0);
    expect(() =>
      openReserveKey("workspace-a", rewrapped, currentEnvelopeKey)
    ).toThrow();
    keypair.privateKey.fill(0);
  });

  it("rewraps Gas Tank data and recovery backup under a new envelope key", () => {
    const currentEnvelopeKey = randomBytes(32).toString("base64");
    const nextEnvelopeKey = randomBytes(32).toString("base64");
    const keypair = generateReserveKeypair();
    const sealed = sealGasTankKey(
      "workspace-a",
      keypair.address,
      keypair.privateKey,
      currentEnvelopeKey
    );

    const rewrapped = rewrapGasTankKey(
      "workspace-a",
      sealed,
      currentEnvelopeKey,
      nextEnvelopeKey
    );

    expect(rewrapped.encryptedPrivateKey).not.toBe(
      sealed.encryptedPrivateKey
    );
    const opened = openGasTankKey(
      "workspace-a",
      rewrapped,
      nextEnvelopeKey
    );
    expect(opened).toEqual(keypair.privateKey);
    opened.fill(0);
    expect(() =>
      openGasTankKey("workspace-a", rewrapped, currentEnvelopeKey)
    ).toThrow();
    keypair.privateKey.fill(0);
  });

  it("rejects a compromised current key or mismatched recovery backup", () => {
    const currentEnvelopeKey = randomBytes(32).toString("base64");
    const keypair = generateReserveKeypair();
    const sealed = sealReserveKey(
      "workspace-a",
      keypair.address,
      keypair.privateKey,
      currentEnvelopeKey
    );

    expect(() =>
      rewrapReserveKey(
        "workspace-a",
        sealed,
        randomBytes(32).toString("base64"),
        randomBytes(32).toString("base64")
      )
    ).toThrow();
    expect(() =>
      rewrapReserveKey(
        "workspace-a",
        { ...sealed, encryptedBackup: "AA==" },
        currentEnvelopeKey,
        randomBytes(32).toString("base64")
      )
    ).toThrow();
    keypair.privateKey.fill(0);
  });
});
