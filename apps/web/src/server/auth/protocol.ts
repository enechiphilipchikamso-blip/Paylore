import {
  createSignInMessageText
} from "@solana/wallet-standard-util";
import {
  z
} from "zod";
import type {
  SolanaSignInInput
} from "@solana/wallet-standard-features";

export const AUTH_CHALLENGE_TTL_MS =
  5 * 60 * 1000;

export const DEVNET_CHAIN_ID =
  "solana:devnet";

export const AUTH_STATEMENT =
  "Sign in to Paylore. This signature authorizes your wallet to access your Paylore account.";

export const solanaSignInInputSchema =
  z.object({
    domain: z.string().min(1),
    address: z.string().min(32).max(64),
    statement: z.string().min(1),
    version: z.literal("1"),
    chainId: z.literal(DEVNET_CHAIN_ID),
    nonce: z.string().regex(
      /^[a-f0-9]{64}$/
    ),
    issuedAt: z.string().datetime(),
    expirationTime:
      z.string().datetime(),
    uri: z.string().url()
  });

export function buildSignInInput(input: {
  walletAddress: string;
  nonce: string;
  issuedAt: Date;
  expirationTime: Date;
  requestUrl: string;
}): SolanaSignInInput {
  const request =
    new URL(input.requestUrl);

  const authUrl = new URL(
    "/auth",
    request.origin
  );

  return {
    domain: authUrl.host,
    address: input.walletAddress,
    statement: AUTH_STATEMENT,
    version: "1",
    chainId: DEVNET_CHAIN_ID,
    nonce: input.nonce,
    issuedAt:
      input.issuedAt.toISOString(),
    expirationTime:
      input.expirationTime.toISOString(),
    uri: authUrl.toString()
  };
}

export function buildChallenge(
  input: Parameters<
    typeof buildSignInInput
  >[0]
): {
  input: SolanaSignInInput;
  message: string;
} {
  const challengeInput =
    buildSignInInput(input);

  return {
    input: challengeInput,
    message:
      createSignInMessageText(
        challengeInput
      )
  };
}

export function challengeIsUsable(
  challenge: Pick<
    {
      issuedAt: Date;
      expirationTime: Date;
      consumedAt: Date | null;
    },
    "issuedAt" |
      "expirationTime" |
      "consumedAt"
  >,
  now: Date
): boolean {
  if (challenge.consumedAt) {
    return false;
  }

  return (
    challenge.issuedAt.getTime() <=
      now.getTime() &&
    challenge.expirationTime.getTime() >
      now.getTime()
  );
}