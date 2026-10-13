import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  generateReserveKeypair,
  openGasTankKey,
  restoreGasTankFromBackup,
  sealGasTankKey
} from "./reserve-crypto-policy";

describe("Gas Tank encrypted key custody", () => {
  it("seals and opens the server key without storing plaintext key bytes", () => {
    const envelopeKey = randomBytes(32).toString("base64");
    const keypair = generateReserveKeypair();
    const sealed = sealGasTankKey(
      "workspace-a",
      keypair.address,
      keypair.privateKey,
      envelopeKey
    );

    expect(JSON.stringify(sealed)).not.toContain(
      keypair.privateKey.toString("base64")
    );
    const opened = openGasTankKey("workspace-a", sealed, envelopeKey);
    expect(opened).toEqual(keypair.privateKey);
    opened.fill(0);
    keypair.privateKey.fill(0);
  });

  it("restores a backup into fresh encrypted key material", () => {
    const envelopeKey = randomBytes(32).toString("base64");
    const keypair = generateReserveKeypair();
    const sealed = sealGasTankKey(
      "workspace-a",
      keypair.address,
      keypair.privateKey,
      envelopeKey
    );

    const restored = restoreGasTankFromBackup(
      "workspace-a",
      sealed,
      envelopeKey
    );
    expect(restored.encryptedPrivateKey).not.toBe(
      sealed.encryptedPrivateKey
    );
    const opened = openGasTankKey("workspace-a", restored, envelopeKey);
    expect(opened).toEqual(keypair.privateKey);
    opened.fill(0);
    keypair.privateKey.fill(0);
  });

  it("rejects a different workspace or envelope key", () => {
    const envelopeKey = randomBytes(32).toString("base64");
    const keypair = generateReserveKeypair();
    const sealed = sealGasTankKey(
      "workspace-a",
      keypair.address,
      keypair.privateKey,
      envelopeKey
    );

    expect(() =>
      openGasTankKey("workspace-b", sealed, envelopeKey)
    ).toThrow();
    expect(() =>
      openGasTankKey(
        "workspace-a",
        sealed,
        randomBytes(32).toString("base64")
      )
    ).toThrow();
    keypair.privateKey.fill(0);
  });
});
