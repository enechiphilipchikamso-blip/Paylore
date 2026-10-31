import nacl from "tweetnacl";

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const BASE58_INDEX = new Map(
  [...BASE58_ALPHABET].map((character, index) => [character, index])
);
const NONCE_BYTES = 24;
const BOX_PUBLIC_KEY_BYTES = 32;

export type MobileDeepLinkWallet = "solflare" | "backpack";
export type MobileDeepLinkCluster = string;

export type WalletEncryptionKeyPair = {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
};

export function encodeBase58(bytes: Uint8Array): string {
  if (bytes.length === 0) return "";

  let leadingZeroes = 0;
  while (leadingZeroes < bytes.length && bytes[leadingZeroes] === 0) {
    leadingZeroes += 1;
  }

  let value = 0n;
  for (const byte of bytes) {
    value = value * 256n + BigInt(byte);
  }

  let encoded = "";
  while (value > 0n) {
    const remainder = Number(value % 58n);
    encoded = BASE58_ALPHABET[remainder] + encoded;
    value /= 58n;
  }

  return "1".repeat(leadingZeroes) + encoded;
}

export function decodeBase58(value: string): Uint8Array {
  if (value.length === 0) return new Uint8Array();

  let decoded = 0n;
  for (const character of value) {
    const digit = BASE58_INDEX.get(character);
    if (digit === undefined) {
      throw new Error("The wallet returned an invalid encoded value.");
    }
    decoded = decoded * 58n + BigInt(digit);
  }

  const leadingZeroes = value.match(/^1*/)?.[0].length ?? 0;
  let hex = decoded === 0n ? "" : decoded.toString(16);
  if (hex.length % 2 !== 0) hex = "0" + hex;

  const bytes = new Uint8Array(hex.length / 2 + leadingZeroes);
  for (let index = 0; index < hex.length; index += 2) {
    bytes[leadingZeroes + index / 2] = Number.parseInt(
      hex.slice(index, index + 2),
      16
    );
  }

  return bytes;
}

export function createWalletEncryptionKeyPair(): WalletEncryptionKeyPair {
  return nacl.box.keyPair();
}

export function deriveWalletSharedSecret(
  walletEncryptionPublicKey: string,
  dappSecretKey: Uint8Array
): Uint8Array {
  const publicKey = decodeBase58(walletEncryptionPublicKey);
  if (
    publicKey.length !== BOX_PUBLIC_KEY_BYTES ||
    dappSecretKey.length !== nacl.box.secretKeyLength
  ) {
    throw new Error("The wallet returned an invalid encryption key.");
  }

  return nacl.box.before(publicKey, dappSecretKey);
}

export function decryptWalletPayload(
  encryptedPayload: string,
  encodedNonce: string,
  sharedSecret: Uint8Array
): unknown {
  const ciphertext = decodeBase58(encryptedPayload);
  const nonce = decodeBase58(encodedNonce);
  if (
    nonce.length !== NONCE_BYTES ||
    ciphertext.length < nacl.box.overheadLength ||
    sharedSecret.length !== nacl.box.sharedKeyLength
  ) {
    throw new Error("The wallet returned an invalid encrypted response.");
  }

  const plaintext = nacl.box.open.after(ciphertext, nonce, sharedSecret);
  if (!plaintext) {
    throw new Error("Paylore could not verify the wallet response.");
  }

  try {
    return JSON.parse(new TextDecoder().decode(plaintext)) as unknown;
  } catch {
    throw new Error("The wallet returned an unreadable response.");
  }
}

export function encryptWalletPayload(
  payload: unknown,
  sharedSecret: Uint8Array
): { nonce: string; payload: string } {
  if (sharedSecret.length !== nacl.box.sharedKeyLength) {
    throw new Error("The wallet connection is no longer valid.");
  }

  const nonce = nacl.randomBytes(NONCE_BYTES);
  const plaintext = new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext = nacl.box.after(plaintext, nonce, sharedSecret);

  return {
    nonce: encodeBase58(nonce),
    payload: encodeBase58(ciphertext)
  };
}

function validateAppAndRedirectUrls(
  appUrl: string,
  redirectLink: string
): { app: URL; redirect: URL } {
  let app: URL;
  let redirect: URL;
  try {
    app = new URL(appUrl);
    redirect = new URL(redirectLink);
  } catch {
    throw new Error("Paylore could not create a valid wallet return link.");
  }

  const isSecure = (url: URL) =>
    url.protocol === "https:" ||
    (url.protocol === "http:" &&
      (url.hostname === "localhost" || url.hostname === "127.0.0.1"));

  if (
    !isSecure(app) ||
    !isSecure(redirect) ||
    app.username ||
    app.password ||
    redirect.username ||
    redirect.password ||
    app.origin !== redirect.origin
  ) {
    throw new Error("Wallet links must stay on Paylore's secure public origin.");
  }

  return { app, redirect };
}

export function buildWalletConnectDeepLink(input: {
  provider: MobileDeepLinkWallet;
  appUrl: string;
  redirectLink: string;
  dappEncryptionPublicKey: Uint8Array;
  cluster: MobileDeepLinkCluster;
}): string {
  const { provider, appUrl, redirectLink, dappEncryptionPublicKey, cluster } =
    input;
  const { app, redirect } = validateAppAndRedirectUrls(appUrl, redirectLink);

  if (
    dappEncryptionPublicKey.length !== BOX_PUBLIC_KEY_BYTES ||
    !/^[a-zA-Z0-9:._-]+$/.test(cluster)
  ) {
    throw new Error("The wallet connection settings are not supported.");
  }

  const baseUrl =
    provider === "solflare"
      ? "https://solflare.com/ul/v1/connect"
      : "https://backpack.app/ul/v1/connect";
  const url = new URL(baseUrl);
  url.searchParams.set("app_url", app.toString());
  url.searchParams.set(
    "dapp_encryption_public_key",
    encodeBase58(dappEncryptionPublicKey)
  );
  url.searchParams.set("redirect_link", redirect.toString());
  url.searchParams.set("cluster", cluster);

  return url.toString();
}

export function buildWalletSignMessageDeepLink(input: {
  provider: MobileDeepLinkWallet;
  appUrl: string;
  dappEncryptionPublicKey: Uint8Array;
  redirectLink: string;
  encryptedPayload: string;
  nonce: string;
}): string {
  const {
    provider,
    appUrl,
    dappEncryptionPublicKey,
    redirectLink,
    encryptedPayload,
    nonce
  } = input;
  const { redirect } = validateAppAndRedirectUrls(appUrl, redirectLink);

  if (
    dappEncryptionPublicKey.length !== BOX_PUBLIC_KEY_BYTES ||
    nonce.length === 0 ||
    encryptedPayload.length === 0
  ) {
    throw new Error("The wallet signing request is not valid.");
  }

  const baseUrl =
    provider === "solflare"
      ? "https://solflare.com/ul/v1/signMessage"
      : "https://backpack.app/ul/v1/signMessage";
  const url = new URL(baseUrl);
  url.searchParams.set(
    "dapp_encryption_public_key",
    encodeBase58(dappEncryptionPublicKey)
  );
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("redirect_link", redirect.toString());
  url.searchParams.set("payload", encryptedPayload);

  return url.toString();
}

export function parseWalletError(params: URLSearchParams): string | null {
  const code = params.get("errorCode");
  if (!code) return null;

  if (code === "4001") {
    return "The wallet request was declined. You can try again.";
  }
  if (code === "4900") {
    return "The wallet could not connect to its Solana network. Try again when it is online.";
  }
  return "The wallet could not complete the request. Reconnect and try again.";
}

export function isValidWalletCallbackState(value: string | null): value is string {
  return Boolean(value && /^[a-f0-9]{48}$/.test(value));
}
