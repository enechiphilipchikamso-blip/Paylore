import {
  address,
  getAddressEncoder
} from "@solana/kit";
import {
  verifySignIn
} from "@solana/wallet-standard-util";
import type {
  SolanaSignInInput,
  SolanaSignInOutput
} from "@solana/wallet-standard-features";
import {
  DEVNET_CHAIN_ID,
  solanaSignInInputSchema
} from "./protocol";

export type WalletProof = {
  walletAddress: string;
  account: {
    address: string;
    publicKey: string;
    chains: string[];
    features: string[];
  };
  signedMessage: string;
  signature: string;
};

type WalletIdentifier =
  `${string}:${string}`;

function isWalletIdentifier(
  value: string
): value is WalletIdentifier {
  const separator =
    value.indexOf(":");

  return (
    separator > 0 &&
    separator < value.length - 1
  );
}

function base64ToBytes(
  value: string
): Uint8Array {
  return Uint8Array.from(
    Buffer.from(value, "base64")
  );
}

function isValidBase64(
  value: string
): boolean {
  return (
    value.length > 0 &&
    value.length % 4 === 0 &&
    /^[A-Za-z0-9+/]*={0,2}$/.test(
      value
    )
  );
}

export async function verifyWalletProof(
  input: {
    challengeInput: SolanaSignInInput;
    expectedAuthUrl: string;
  },
  proof: WalletProof
): Promise<boolean> {
  const parsedChallenge =
    solanaSignInInputSchema.safeParse(
      input.challengeInput
    );

  if (!parsedChallenge.success) {
    return false;
  }

  const expectedUrl =
    new URL(input.expectedAuthUrl);

  if (
    parsedChallenge.data.address !==
    proof.walletAddress ||
    proof.account.address !==
      proof.walletAddress
  ) {
    return false;
  }

  if (
    parsedChallenge.data.chainId !==
      DEVNET_CHAIN_ID ||
    parsedChallenge.data.domain !==
      expectedUrl.host ||
    parsedChallenge.data.uri !==
      expectedUrl.toString()
  ) {
    return false;
  }

  if (
    !proof.account.chains.every(
      isWalletIdentifier
    ) ||
    !proof.account.features.every(
      isWalletIdentifier
    )
  ) {
    return false;
  }

  if (
    !isValidBase64(
      proof.account.publicKey
    ) ||
    !isValidBase64(
      proof.signedMessage
    ) ||
    !isValidBase64(
      proof.signature
    )
  ) {
    return false;
  }

  try {
    const expectedPublicKey =
      getAddressEncoder().encode(
        address(proof.walletAddress)
      );

    const publicKeyMatches =
      Buffer.from(
        expectedPublicKey
      ).equals(
        Buffer.from(
          base64ToBytes(
            proof.account.publicKey
          )
        )
      );

    if (!publicKeyMatches) {
      return false;
    }

    const output: SolanaSignInOutput = {
      account: {
        address:
          proof.account.address,
        publicKey:
          base64ToBytes(
            proof.account.publicKey
          ),
        chains:
          proof.account.chains,
        features:
          proof.account.features
      },
      signedMessage:
        base64ToBytes(
          proof.signedMessage
        ),
      signature:
        base64ToBytes(
          proof.signature
        )
    };

    return Boolean(
      await verifySignIn(
        parsedChallenge.data,
        output
      )
    );
  } catch {
    return false;
  }
}