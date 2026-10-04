import "server-only";

import {
  createSignInMessageText
} from "@solana/wallet-standard-util";
import type {
  SolanaSignInInput
} from "@solana/wallet-standard-features";

export const AUTH_CHALLENGE_TTL_MS =
  5 * 60 * 1000;

export const DEVNET_CHAIN_ID =
  "solana:devnet";

export const AUTH_STATEMENT =
  "Sign in to Paylore. This signature authorizes your wallet to access your Paylore account.";

export type AuthChallengeRecord = {
  nonce: string;
  walletAddress: string;
  input: SolanaSignInInput;
  message: string;
  issuedAt: Date;
  expirationTime: Date;
  consumedAt: Date | null;
};

export function buildSignInInput(input: {
  walletAddress: string;
  nonce: string;
  issuedAt: Date;
  expirationTime: Date;
  requestUrl: string;
}): SolanaSignInInput {
  const authUrl = new URL(
    "/auth",
    input.requestUrl
  );

  return {
    domain: authUrl.host,
    address: input.walletAddress,
    statement: AUTH_STATEMENT,
    version: "1",
    chainId: DEVNET_CHAIN_ID,
    nonce: input.nonce,
    issuedAt: input.issuedAt.toISOString(),
    expirationTime:
      input.expirationTime.toISOString(),
    uri: authUrl.toString()
  };
}

export function buildChallenge(
  input: Parameters<typeof buildSignInInput>[0]
): {
  input: SolanaSignInInput;
  message: string;
} {
  const challengeInput = buildSignInInput(input);

  return {
    input: challengeInput,
    message: createSignInMessageText(
      challengeInput
    )
  };
}

export function challengeIsUsable(
  challenge: Pick<
    AuthChallengeRecord,
    "issuedAt" | "expirationTime" | "consumedAt"
  >,
  now: Date
): boolean {
  if (challenge.consumedAt) {
    return false;
  }

  return (
    challenge.issuedAt.getTime() <= now.getTime() &&
    challenge.expirationTime.getTime() >
      now.getTime()
  );
}