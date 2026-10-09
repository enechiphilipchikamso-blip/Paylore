import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  hkdfSync,
  randomBytes
} from "node:crypto";

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const ED25519_PKCS8_PREFIX =
  Buffer.from("302e020100300506032b657004220420", "hex");

export type SealedReserve = {
  address: string;
  encryptedPrivateKey: string;
  privateKeyNonce: string;
  privateKeyAuthTag: string;
  encryptedDataKey: string;
  dataKeyNonce: string;
  dataKeyAuthTag: string;
  encryptedBackup: string;
  backupNonce: string;
  backupAuthTag: string;
};

function encodeBase58(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) {
    value = (value << 8n) | BigInt(byte);
  }

  let encoded = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    encoded = BASE58_ALPHABET[remainder] + encoded;
    value /= 58n;
  }

  let leadingZeroes = 0;
  while (
    leadingZeroes < bytes.length &&
    bytes[leadingZeroes] === 0
  ) {
    leadingZeroes += 1;
  }

  return "1".repeat(leadingZeroes) + (encoded || (leadingZeroes ? "" : "1"));
}

function getEnvelopeKey(encodedKey: string): Buffer {
  const key = Buffer.from(encodedKey, "base64");
  if (
    key.length !== 32 ||
    key.toString("base64") !== encodedKey
  ) {
    throw new Error(
      "The reserve envelope key must be a base64-encoded 32-byte key."
    );
  }
  return key;
}

function deriveKey(
  envelopeKey: Buffer,
  workspaceId: string,
  purpose: string
): Buffer {
  return Buffer.from(
    hkdfSync(
      "sha256",
      envelopeKey,
      Buffer.from(workspaceId, "utf8"),
      Buffer.from(`paylore:reserve:v1:${purpose}`, "utf8"),
      32
    )
  );
}

function encrypt(
  plaintext: Uint8Array,
  key: Buffer,
  associatedData: string
) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(Buffer.from(associatedData, "utf8"));
  const ciphertext = Buffer.concat([
    cipher.update(plaintext),
    cipher.final()
  ]);
  return {
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64")
  };
}

function decrypt(
  encrypted: {
    ciphertext: string;
    nonce: string;
    authTag: string;
  },
  key: Buffer,
  associatedData: string
): Buffer {
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(encrypted.nonce, "base64")
  );
  decipher.setAAD(Buffer.from(associatedData, "utf8"));
  decipher.setAuthTag(
    Buffer.from(encrypted.authTag, "base64")
  );
  return Buffer.concat([
    decipher.update(
      Buffer.from(encrypted.ciphertext, "base64")
    ),
    decipher.final()
  ]);
}

function deriveAddress(secret: Uint8Array): string {
  if (secret.length !== 64) {
    throw new Error("Reserve key material has an invalid length.");
  }
  const privateKey = createPrivateKey({
    key: Buffer.concat([
      ED25519_PKCS8_PREFIX,
      Buffer.from(secret.subarray(0, 32))
    ]),
    format: "der",
    type: "pkcs8"
  });
  const publicKey = createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  if (!Buffer.from(publicKey).equals(Buffer.from(secret.subarray(32)))) {
    throw new Error("Reserve key material failed public-key validation.");
  }
  return encodeBase58(publicKey);
}

export function generateReserveKeypair(): {
  address: string;
  privateKey: Buffer;
} {
  const seed = randomBytes(32);
  const privateKey = createPrivateKey({
    key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8"
  });
  const publicKey = createPublicKey(privateKey)
    .export({ format: "der", type: "spki" })
    .subarray(-32);
  const secret = Buffer.concat([
    seed,
    Buffer.from(publicKey)
  ]);
  return {
    address: encodeBase58(publicKey),
    privateKey: secret
  };
}

export function sealReserveKey(
  workspaceId: string,
  address: string,
  privateKey: Uint8Array,
  encodedEnvelopeKey: string
): SealedReserve {
  if (deriveAddress(privateKey) !== address) {
    throw new Error("Reserve public address does not match its keypair.");
  }

  const envelopeKey = getEnvelopeKey(encodedEnvelopeKey);
  const dataKey = randomBytes(32);
  const secretAad = `${workspaceId}:private-key`;
  const wrappedKeyAad = `${workspaceId}:data-key`;
  const backupAad = `${workspaceId}:backup`;
  const sealedSecret = encrypt(privateKey, dataKey, secretAad);
  const sealedDataKey = encrypt(
    dataKey,
    deriveKey(envelopeKey, workspaceId, "data-key"),
    wrappedKeyAad
  );
  const backupPayload = Buffer.from(
    JSON.stringify({
      workspaceId,
      address,
      privateKey: Buffer.from(privateKey).toString("base64"),
      dataKey: dataKey.toString("base64")
    }),
    "utf8"
  );
  const sealedBackup = encrypt(
    backupPayload,
    deriveKey(envelopeKey, workspaceId, "backup"),
    backupAad
  );

  return {
    address,
    encryptedPrivateKey: sealedSecret.ciphertext,
    privateKeyNonce: sealedSecret.nonce,
    privateKeyAuthTag: sealedSecret.authTag,
    encryptedDataKey: sealedDataKey.ciphertext,
    dataKeyNonce: sealedDataKey.nonce,
    dataKeyAuthTag: sealedDataKey.authTag,
    encryptedBackup: sealedBackup.ciphertext,
    backupNonce: sealedBackup.nonce,
    backupAuthTag: sealedBackup.authTag
  };
}

type EncryptedReserve = SealedReserve;

export function openReserveKey(
  workspaceId: string,
  sealed: EncryptedReserve,
  encodedEnvelopeKey: string
): Buffer {
  const envelopeKey = getEnvelopeKey(encodedEnvelopeKey);
  const dataKey = decrypt(
    {
      ciphertext: sealed.encryptedDataKey,
      nonce: sealed.dataKeyNonce,
      authTag: sealed.dataKeyAuthTag
    },
    deriveKey(envelopeKey, workspaceId, "data-key"),
    `${workspaceId}:data-key`
  );
  if (dataKey.length !== 32) {
    throw new Error("The reserve data key is invalid.");
  }

  const privateKey = decrypt(
    {
      ciphertext: sealed.encryptedPrivateKey,
      nonce: sealed.privateKeyNonce,
      authTag: sealed.privateKeyAuthTag
    },
    dataKey,
    `${workspaceId}:private-key`
  );
  if (deriveAddress(privateKey) !== sealed.address) {
    privateKey.fill(0);
    throw new Error("The reserve key failed integrity verification.");
  }
  return privateKey;
}

export function restoreReserveFromBackup(
  workspaceId: string,
  sealed: EncryptedReserve,
  encodedEnvelopeKey: string
): SealedReserve {
  const envelopeKey = getEnvelopeKey(encodedEnvelopeKey);
  const backup = decrypt(
    {
      ciphertext: sealed.encryptedBackup,
      nonce: sealed.backupNonce,
      authTag: sealed.backupAuthTag
    },
    deriveKey(envelopeKey, workspaceId, "backup"),
    `${workspaceId}:backup`
  );

  let payload: {
    workspaceId?: unknown;
    address?: unknown;
    privateKey?: unknown;
    dataKey?: unknown;
  };
  try {
    payload = JSON.parse(backup.toString("utf8")) as typeof payload;
  } catch {
    throw new Error("The reserve recovery backup is invalid.");
  }

  if (
    payload.workspaceId !== workspaceId ||
    payload.address !== sealed.address ||
    typeof payload.privateKey !== "string"
  ) {
    throw new Error(
      "The reserve recovery backup does not match this workspace."
    );
  }

  const privateKey = Buffer.from(payload.privateKey, "base64");
  if (deriveAddress(privateKey) !== sealed.address) {
    privateKey.fill(0);
    throw new Error("The reserve recovery backup failed validation.");
  }

  try {
    return sealReserveKey(
      workspaceId,
      sealed.address,
      privateKey,
      encodedEnvelopeKey
    );
  } finally {
    privateKey.fill(0);
    backup.fill(0);
    envelopeKey.fill(0);
  }
}
