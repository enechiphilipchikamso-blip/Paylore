import nacl from "tweetnacl";
import { describe, expect, it } from "vitest";
import {
  buildWalletConnectDeepLink,
  buildWalletSignMessageDeepLink,
  createWalletEncryptionKeyPair,
  decodeBase58,
  decryptWalletPayload,
  deriveWalletSharedSecret,
  encodeBase58,
  encryptWalletPayload,
  parseWalletError
} from "./mobile-wallet-deeplink";

const APP_URL = "https://paylore.netlify.app/";
const REDIRECT_URL =
  "https://paylore.netlify.app/auth?wallet_provider=solflare&wallet_action=connect&wallet_state=0123456789abcdef0123456789abcdef0123456789abcdef";

describe("Solana mobile wallet deeplinks", () => {
  it("round-trips Base58 bytes, including leading zero bytes", () => {
    const input = Uint8Array.from([0, 0, 1, 2, 255, 0, 13]);
    expect(decodeBase58(encodeBase58(input))).toEqual(input);
    expect(encodeBase58(new Uint8Array([0, 0, 0]))).toBe("111");
    expect(decodeBase58("111")).toEqual(new Uint8Array([0, 0, 0]));
    expect(() => decodeBase58("0OIl")).toThrow(
      "The wallet returned an invalid encoded value."
    );
  });

  it("sends the actual public Paylore URL, ephemeral key and same-origin return URL to Solflare", () => {
    const keyPair = createWalletEncryptionKeyPair();
    const url = new URL(
      buildWalletConnectDeepLink({
        provider: "solflare",
        appUrl: APP_URL,
        redirectLink: REDIRECT_URL,
        dappEncryptionPublicKey: keyPair.publicKey,
        cluster: "devnet"
      })
    );

    expect(url.origin).toBe("https://solflare.com");
    expect(url.pathname).toBe("/ul/v1/connect");
    expect(url.searchParams.get("app_url")).toBe(APP_URL);
    expect(url.searchParams.get("redirect_link")).toBe(REDIRECT_URL);
    expect(url.searchParams.get("cluster")).toBe("devnet");
    expect(
      decodeBase58(url.searchParams.get("dapp_encryption_public_key")!)
    ).toEqual(keyPair.publicKey);
  });

  it("uses URL query encoding rather than embedding or double-encoding the redirect URL", () => {
    const keyPair = createWalletEncryptionKeyPair();
    const url = buildWalletConnectDeepLink({
      provider: "solflare",
      appUrl: APP_URL,
      redirectLink: REDIRECT_URL,
      dappEncryptionPublicKey: keyPair.publicKey,
      cluster: "devnet"
    });

    expect(url).toContain("redirect_link=https%3A%2F%2Fpaylore.netlify.app%2Fauth");
    expect(url).not.toContain("redirect_link=https://paylore.netlify.app");
    expect(new URL(url).searchParams.get("redirect_link")).toBe(REDIRECT_URL);
  });

  it("rejects a return URL outside Paylore's public origin", () => {
    const keyPair = createWalletEncryptionKeyPair();
    expect(() =>
      buildWalletConnectDeepLink({
        provider: "solflare",
        appUrl: APP_URL,
        redirectLink: "https://attacker.example/return",
        dappEncryptionPublicKey: keyPair.publicKey,
        cluster: "devnet"
      })
    ).toThrow("Wallet links must stay on Paylore's secure public origin.");
  });

  it("passes the explicitly selected cluster to the Backpack connection URL", () => {
    const keyPair = createWalletEncryptionKeyPair();
    const url = new URL(
      buildWalletConnectDeepLink({
        provider: "backpack",
        appUrl: APP_URL,
        redirectLink: REDIRECT_URL,
        dappEncryptionPublicKey: keyPair.publicKey,
        cluster: "mainnet-beta"
      })
    );

    expect(url.origin).toBe("https://backpack.app");
    expect(url.pathname).toBe("/ul/v1/connect");
    expect(url.searchParams.get("app_url")).toBe(APP_URL);
    expect(url.searchParams.get("redirect_link")).toBe(REDIRECT_URL);
    expect(url.searchParams.get("cluster")).toBe("mainnet-beta");
    expect(
      decodeBase58(url.searchParams.get("dapp_encryption_public_key")!)
    ).toEqual(keyPair.publicKey);
  });

  it("decrypts a provider response with the documented X25519 shared-key flow", () => {
    const dapp = createWalletEncryptionKeyPair();
    const wallet = createWalletEncryptionKeyPair();
    const walletSideSecret = nacl.box.before(
      dapp.publicKey,
      wallet.secretKey
    );
    const nonce = nacl.randomBytes(24);
    const response = {
      public_key: "3huUrtWW5s5ew98eUFRYz9LPsDUQTujNzzYaB9DBkppQ",
      session: encodeBase58(Uint8Array.from([9, 8, 7, 6]))
    };
    const ciphertext = nacl.box.after(
      new TextEncoder().encode(JSON.stringify(response)),
      nonce,
      walletSideSecret
    );

    const dappSideSecret = deriveWalletSharedSecret(
      encodeBase58(wallet.publicKey),
      dapp.secretKey
    );
    const decrypted = decryptWalletPayload(
      encodeBase58(ciphertext),
      encodeBase58(nonce),
      dappSideSecret
    );

    expect(decrypted).toEqual(response);
  });

  it("encrypts a UTF-8 sign-message request and places the encoded protocol fields in the URL", () => {
    const keyPair = createWalletEncryptionKeyPair();
    const sharedSecret = nacl.randomBytes(nacl.box.sharedKeyLength);
    const message = "Paylore sign-in challenge";
    const encrypted = encryptWalletPayload(
      {
        session: "opaque-session-token",
        message: encodeBase58(new TextEncoder().encode(message)),
        display: "utf8"
      },
      sharedSecret
    );
    const url = new URL(
      buildWalletSignMessageDeepLink({
        provider: "solflare",
        appUrl: APP_URL,
        dappEncryptionPublicKey: keyPair.publicKey,
        redirectLink: REDIRECT_URL.replace(
          "wallet_action=connect",
          "wallet_action=sign_message"
        ),
        encryptedPayload: encrypted.payload,
        nonce: encrypted.nonce
      })
    );

    expect(url.origin).toBe("https://solflare.com");
    expect(url.pathname).toBe("/ul/v1/signMessage");
    expect(url.searchParams.get("dapp_encryption_public_key")).toBe(
      encodeBase58(keyPair.publicKey)
    );
    expect(url.searchParams.get("nonce")).toBe(encrypted.nonce);
    expect(url.searchParams.get("payload")).toBe(encrypted.payload);
    expect(url.searchParams.get("redirect_link")).toContain(
      "wallet_action=sign_message"
    );
  });

  it("builds the Backpack message-signing deep link using the established connection session", () => {
    const keyPair = createWalletEncryptionKeyPair();
    const sharedSecret = nacl.randomBytes(nacl.box.sharedKeyLength);
    const encrypted = encryptWalletPayload(
      {
        session: "opaque-session-token",
        message: encodeBase58(new TextEncoder().encode("Paylore sign-in challenge")),
        display: "utf8"
      },
      sharedSecret
    );
    const url = new URL(
      buildWalletSignMessageDeepLink({
        provider: "backpack",
        appUrl: APP_URL,
        dappEncryptionPublicKey: keyPair.publicKey,
        redirectLink: "https://paylore.netlify.app/auth?wallet_provider=backpack&wallet_action=sign_message&wallet_state=0123456789abcdef0123456789abcdef0123456789abcdef",
        encryptedPayload: encrypted.payload,
        nonce: encrypted.nonce
      })
    );

    expect(url.origin).toBe("https://backpack.app");
    expect(url.pathname).toBe("/ul/v1/signMessage");
    expect(url.searchParams.get("dapp_encryption_public_key")).toBe(
      encodeBase58(keyPair.publicKey)
    );
    expect(url.searchParams.get("nonce")).toBe(encrypted.nonce);
    expect(url.searchParams.get("payload")).toBe(encrypted.payload);
    expect(url.searchParams.get("redirect_link")).toBe("https://paylore.netlify.app/auth?wallet_provider=backpack&wallet_action=sign_message&wallet_state=0123456789abcdef0123456789abcdef0123456789abcdef");
  });

  it("maps only the published cancellation and disconnect codes to specific copy", () => {
    expect(
      parseWalletError(new URLSearchParams("errorCode=4001"))
    ).toContain("declined");
    expect(
      parseWalletError(new URLSearchParams("errorCode=4900"))
    ).toContain("network");
    expect(
      parseWalletError(new URLSearchParams("errorCode=-32603"))
    ).toBe("The wallet could not complete the request. Reconnect and try again.");
    expect(parseWalletError(new URLSearchParams("data=abc"))).toBeNull();
  });
});
