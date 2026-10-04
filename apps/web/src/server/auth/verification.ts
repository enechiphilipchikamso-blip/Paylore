import "server-only";

import {
  address,
  getAddressEncoder,
  getBase64Encoder,
  getPublicKeyFromAddress,
  getUtf8Encoder,
  signatureBytes,
  verifySignature
} from "@solana/kit";
import {
  verifySignIn
} from "@solana/wallet-standard-util";
import type {
  SolanaSignInInput,
  SolanaSignInOutput
} from "@solana/wallet-standard-features";
import {
  DEVNET_CHAIN_ID
} from "./protocol";

type WalletProof = {
  method: "siws" | "raw";
  walletAddress: string;
  signature: string;
  signedMessage?: string;
};

export async function verifyWalletProof(
  input: {
    challengeInput: SolanaSignInInput;
    expectedMessage: string;
  },
  proof: WalletProof
): Promise<boolean> {
  if (
    input.challengeInput.address !==
    proof.walletAddress
  ) {
    return false;
  }

  if (
    input.challengeInput.chainId !==
    DEVNET_CHAIN_ID
  ) {
    return false;
  }

  const expectedAuthUri = new URL(
    "/auth",
    `https://${input.challengeInput.domain}`
  );

  if (
    input.challengeInput.uri !==
    expectedAuthUri.toString()
  ) {
    return false;
  }

  if (proof.method === "siws") {
    if (!proof.signedMessage) {
      return false;
    }

    try {
      const signInOutput: SolanaSignInOutput = {
        account: {
          address: proof.walletAddress,
          publicKey:
            getAddressEncoder().encode(
              address(proof.walletAddress)
            ),
          chains: [DEVNET_CHAIN_ID],
          features: []
        },
        signedMessage:
          getBase64Encoder().encode(
            proof.signedMessage
          ),
        signature:
          getBase64Encoder().encode(
            proof.signature
          )
      };

      return await verifySignIn(
        input.challengeInput,
        signInOutput
      );
    } catch {
      return false;
    }
  }

  try {
    const publicKey =
      await getPublicKeyFromAddress(
        address(proof.walletAddress)
      );

    const valid = await verifySignature(
      publicKey,
      signatureBytes(
        getBase64Encoder().encode(
          proof.signature
        )
      ),
      getUtf8Encoder().encode(
        input.expectedMessage
      )
    );

    return Boolean(valid);
  } catch {
    return false;
  }
}