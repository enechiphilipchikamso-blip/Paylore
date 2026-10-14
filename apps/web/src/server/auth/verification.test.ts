import {
  describe,
  expect,
  it
} from "vitest";
import {
  generateKeyPairSync,
  sign
} from "node:crypto";
import {
  createSignInMessage
} from "@solana/wallet-standard-util";
import {
  verifyWalletProof
} from "./verification";
import {
  buildChallenge
} from "./protocol";

const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

function encodeBase58(
  bytes: Uint8Array
): string {
  let value = 0n;

  for (const byte of bytes) {
    value =
      value * 256n +
      BigInt(byte);
  }

  let encoded = "";

  while (value > 0n) {
    const remainder =
      Number(value % 58n);
    encoded =
      BASE58_ALPHABET[remainder] +
      encoded;
    value /= 58n;
  }

  const leadingZeroes =
    bytes.findIndex(
      (byte) => byte !== 0
    );

  return (
    "1".repeat(
      leadingZeroes === -1
        ? bytes.length
        : leadingZeroes
    ) + encoded
  );
}

describe(
  "wallet proof verification",
  () => {
    const walletAddress =
      "11111111111111111111111111111111";

    const challengeInput = {
      domain: "paylore.example",
      address: walletAddress,
      statement: "Sign in to Paylore.",
      version: "1",
      chainId: "solana:devnet",
      nonce: "a".repeat(64),
      issuedAt:
        "2026-10-04T08:00:00.000Z",
      expirationTime:
        "2026-10-04T08:05:00.000Z",
      uri: "https://paylore.example/auth"
    } as const;

    const proof = {
      walletAddress,
      account: {
        address: walletAddress,
        publicKey:
          Buffer.alloc(32).toString("base64"),
        chains: ["solana:devnet"],
        features: ["solana:signIn"]
      },
      signedMessage:
        Buffer.from("signed message").toString("base64"),
      signature:
        Buffer.alloc(64).toString("base64")
    };

    async function verifyAccount(
      account: typeof proof.account
    ) {
      return verifyWalletProof(
        {
          challengeInput,
          expectedAuthUrl:
            "https://paylore.example/auth"
        },
        {
          ...proof,
          account
        }
      );
    }

    it(
      "rejects non-namespaced chains",
      async () => {
        await expect(
          verifyAccount({
            ...proof.account,
            chains: ["invalid"]
          })
        ).resolves.toBe(false);
      }
    );

    it(
      "rejects non-namespaced features",
      async () => {
        await expect(
          verifyAccount({
            ...proof.account,
            features: ["invalid"]
          })
        ).resolves.toBe(false);
      }
    );

    it(
      "accepts a valid signed SIWS proof",
      async () => {
        const { privateKey, publicKey } =
          generateKeyPairSync("ed25519");
        const rawPublicKey =
          new Uint8Array(
            publicKey
              .export({
                format: "der",
                type: "spki"
              })
              .subarray(-32)
          );
        const address =
          encodeBase58(rawPublicKey);
        const issuedAt = new Date();
        const challenge =
          buildChallenge({
            walletAddress: address,
            nonce: "b".repeat(64),
            issuedAt,
            expirationTime: new Date(
              issuedAt.getTime() + 5 * 60 * 1000
            ),
            requestUrl:
              "https://paylore.example/api/auth/challenge"
          });
        const signedMessage =
          createSignInMessage(
            challenge.input
          );
        const signature =
          sign(
            null,
            signedMessage,
            privateKey
          );
        const proof = {
          walletAddress: address,
          account: {
            address,
            publicKey:
              Buffer.from(
                rawPublicKey
              ).toString("base64"),
            chains: ["solana:devnet"],
            features: ["solana:signIn"]
          },
          signedMessage:
            Buffer.from(
              signedMessage
            ).toString("base64"),
          signature:
            signature.toString("base64")
        };

        await expect(
          verifyWalletProof(
            {
              challengeInput:
                challenge.input,
              expectedAuthUrl:
                "https://paylore.example/auth"
            },
            proof
          )
        ).resolves.toBe(true);

        const verificationInput = {
          expectedAuthUrl:
            "https://paylore.example/auth"
        };

        const tamperedSignature =
          Buffer.from(signature);
        tamperedSignature[0] ^= 1;

        const invalidProofs = [
          {
            challengeInput: {
              ...challenge.input,
              nonce: "c".repeat(64)
            },
            proof
          },
          {
            challengeInput: challenge.input,
            proof: {
              ...proof,
              walletAddress:
                "11111111111111111111111111111111"
            }
          },
          {
            challengeInput: challenge.input,
            proof: {
              ...proof,
              account: {
                ...proof.account,
                publicKey:
                  Buffer.alloc(32, 1).toString("base64")
              }
            }
          },
          {
            challengeInput: challenge.input,
            proof: {
              ...proof,
              signedMessage:
                Buffer.from(
                  "tampered message"
                ).toString("base64")
            }
          },
          {
            challengeInput: challenge.input,
            proof: {
              ...proof,
              signature:
                tamperedSignature.toString("base64")
            }
          }
        ];

        for (const invalid of invalidProofs) {
          await expect(
            verifyWalletProof(
              {
                ...verificationInput,
                challengeInput:
                  invalid.challengeInput
              },
              invalid.proof
            )
          ).resolves.toBe(false);
        }
      }
    );
  }
);
