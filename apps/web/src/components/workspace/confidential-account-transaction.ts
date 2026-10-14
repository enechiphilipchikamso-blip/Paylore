"use client";

import {
  getCreateConfidentialTransferAccountInstructionPlan,
  fetchConfidentialTransferBalance,
  getApplyConfidentialPendingBalanceInstructionFromToken,
  getEmptyConfidentialTransferAccountInstructionPlan,
  getConfidentialWithdrawInstructionPlan
} from "@solana-program/token-2022/confidential";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  fetchMint,
  fetchToken,
  findAssociatedTokenPda,
  getCloseAccountInstruction
} from "@solana-program/token-2022";
import {
  AeKey,
  ElGamalKeypair,
  ElGamalSecretKey
} from "@solana/zk-sdk/bundler";
import {
  address,
  blockhash,
  createNoopSigner,
  createSolanaRpc,
  createTransactionMessage,
  createTransactionPlanExecutorWithConcurrentLeaves,
  createTransactionPlanner,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  isSome,
  partiallySignTransactionMessageWithSigners,
  signature,
  signatureBytes,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  type Signature,
  type InstructionPlan
} from "@solana/kit";
import type { findAuthenticatedWallet } from "./authenticated-wallet";

type Wallet = Awaited<ReturnType<typeof findAuthenticatedWallet>>;
const DEVNET_RPC_URL = "https://api.devnet.solana.com";
const FINALITY_TIMEOUT_MS = 120_000;

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((byte, index) => byte === right[index]);
}

async function deriveWalletKeys(wallet: Wallet) {
  const signMessage = wallet.signMessage;
  if (!signMessage) {
    throw new Error(
      "This wallet cannot securely derive the confidential account keys required for this operation."
    );
  }
  const owner = address(wallet.account.address);
  const signer = {
    address: owner,
    signMessages: async (messages: readonly { content: Uint8Array }[]) => {
      const outputs = await signMessage(
        ...messages.map((message) => ({
          account: wallet.account,
          message: message.content
        }))
      );
      return outputs.map((output) => {
        const matchingMessage = messages.find((message) =>
          sameBytes(message.content, output.signedMessage)
        );
        if (
          !matchingMessage ||
          (output.signatureType !== undefined &&
            output.signatureType !== "ed25519") ||
          output.signature.length !== 64
        ) {
          throw new Error(
            "The wallet did not return an exact Ed25519 confidential-key derivation signature."
          );
        }
        return { [owner]: signatureBytes(output.signature) };
      });
    }
  };
  return { owner, keys: await import("@solana-program/token-2022/confidential").then(
    ({ deriveConfidentialKeys }) => deriveConfidentialKeys({ signer })
  ) };
}

async function executePlan(wallet: Wallet, plan: InstructionPlan): Promise<string[]> {
  const rpc = createSolanaRpc(DEVNET_RPC_URL);
  const owner = address(wallet.account.address);
  const feePayer = createNoopSigner(owner);
  const planner = createTransactionPlanner({
    createTransactionMessage: () =>
      setTransactionMessageFeePayerSigner(
        feePayer,
        createTransactionMessage({ version: 0 })
      ),
    onTransactionMessageUpdated: async (message) => {
      const latest = await rpc.getLatestBlockhash({ commitment: "confirmed" }).send();
      return setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash(latest.value.blockhash),
          lastValidBlockHeight: BigInt(latest.value.lastValidBlockHeight)
        },
        message
      );
    }
  });
  const transactionPlan = await planner(plan);
  const signatures: string[] = [];
  const executor = createTransactionPlanExecutorWithConcurrentLeaves({
    executeTransactionMessage: async (_context, message) => {
      const partiallySigned =
        await partiallySignTransactionMessageWithSigners(message);
      const encoded = getBase64EncodedWireTransaction(partiallySigned);
      const transaction = Uint8Array.from(atob(encoded), (character) =>
        character.charCodeAt(0)
      );
      const [result] = await wallet.signAndSendTransaction({
        account: wallet.account,
        chain: "solana:devnet",
        transaction,
        options: { commitment: "confirmed" }
      });
      const encodedSignature = getBase58Decoder().decode(result.signature);
      const transactionSignature = signature(encodedSignature);
      signatures.push(encodedSignature);
      await waitForFinality(rpc, transactionSignature);
      return { signature: transactionSignature };
    }
  });
  await executor(transactionPlan);
  return signatures;
}

async function waitForFinality(
  rpc: ReturnType<typeof createSolanaRpc>,
  transactionSignature: Signature
): Promise<void> {
  const deadline = Date.now() + FINALITY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await rpc
      .getSignatureStatuses([transactionSignature], { searchTransactionHistory: true })
      .send();
    const status = result.value[0];
    if (status?.err) {
      throw new Error("The confidential-account transaction failed on Devnet.");
    }
    if (status?.confirmationStatus === "finalized") return;
    await new Promise((resolve) => window.setTimeout(resolve, 1_000));
  }
  throw new Error(
    `The transaction was submitted but has not finalized: ${transactionSignature}`
  );
}

function requireConfidentialMintExtensions(
  extensions: readonly { __kind: string }[]
): boolean {
  if (!extensions.some((extension) => extension.__kind === "ConfidentialTransferMint")) {
    throw new Error(
      "The configured wrapped-USDC mint is not initialized with Token-2022 confidential transfers."
    );
  }
  return extensions.some((extension) => extension.__kind === "TransferFeeConfig");
}

export async function setupConfidentialAccount(
  wallet: Wallet,
  mintAddress: string
): Promise<{ tokenAccountAddress: string; signature: string }> {
  const rpc = createSolanaRpc(DEVNET_RPC_URL);
  const mint = address(mintAddress);
  const mintAccount = await fetchMint(rpc, mint);
  const includeConfidentialTransferFeeAmount = requireConfidentialMintExtensions(
    isSome(mintAccount.data.extensions)
      ? mintAccount.data.extensions.value
      : []
  );
  const { owner, keys } = await deriveWalletKeys(wallet);
  const secretKey = ElGamalSecretKey.fromBytes(keys.elgamalKeypair.secretKey);
  const elgamalKeypair = ElGamalKeypair.fromSecretKey(secretKey);
  const aeKey = AeKey.fromBytes(keys.aeKey);
  try {
    const [tokenAccount] = await findAssociatedTokenPda({
      mint,
      owner,
      tokenProgram: TOKEN_2022_PROGRAM_ADDRESS
    });
    const plan = await getCreateConfidentialTransferAccountInstructionPlan({
      payer: createNoopSigner(owner),
      owner: createNoopSigner(owner),
      mint,
      token: tokenAccount,
      rpc,
      elgamalKeypair,
      aesKey: aeKey,
      includeConfidentialTransferFeeAmount
    });
    const [signature] = await executePlan(wallet, plan);
    return { tokenAccountAddress: tokenAccount, signature };
  } finally {
    secretKey.free();
    elgamalKeypair.free();
    aeKey.free();
    keys.elgamalKeypair.secretKey.fill(0);
    keys.aeKey.fill(0);
  }
}

export async function getConfidentialBalances(
  wallet: Wallet,
  mintAddress: string,
  tokenAccountAddress: string
) {
  const rpc = createSolanaRpc(DEVNET_RPC_URL);
  const { keys } = await deriveWalletKeys(wallet);
  const secretKey = ElGamalSecretKey.fromBytes(keys.elgamalKeypair.secretKey);
  const elgamalKeypair = ElGamalKeypair.fromSecretKey(secretKey);
  const aeKey = AeKey.fromBytes(keys.aeKey);
  try {
    const mint = address(mintAddress);
    const mintAccount = await fetchMint(rpc, mint);
    requireConfidentialMintExtensions(
      isSome(mintAccount.data.extensions)
        ? mintAccount.data.extensions.value
        : []
    );
    const tokenAccount = address(tokenAccountAddress);
    const { data } = await fetchToken(rpc, tokenAccount);
    return {
      ...await fetchConfidentialTransferBalance({
        token: tokenAccount,
        rpc,
        elgamalSecretKey: secretKey,
        aesKey: aeKey
      }),
      publicBalance: data.amount
    };
  } finally {
    secretKey.free();
    elgamalKeypair.free();
    aeKey.free();
    keys.elgamalKeypair.secretKey.fill(0);
    keys.aeKey.fill(0);
  }
}

export async function closeConfidentialAccount(
  wallet: Wallet,
  mintAddress: string,
  tokenAccountAddress: string
): Promise<string[]> {
  const rpc = createSolanaRpc(DEVNET_RPC_URL);
  const owner = address(wallet.account.address);
  const mint = address(mintAddress);
  const token = address(tokenAccountAddress);
  const [expectedToken] = await findAssociatedTokenPda({
    mint,
    owner,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS
  });
  if (expectedToken !== token) {
    throw new Error("The confidential account does not belong to this wallet.");
  }

  const { keys } = await deriveWalletKeys(wallet);
  const secretKey = ElGamalSecretKey.fromBytes(keys.elgamalKeypair.secretKey);
  const elgamalKeypair = ElGamalKeypair.fromSecretKey(secretKey);
  const aeKey = AeKey.fromBytes(keys.aeKey);
  try {
    const tokenAccount = await fetchToken(rpc, token);
    const balance = await fetchConfidentialTransferBalance({
      token,
      rpc,
      elgamalSecretKey: secretKey,
      aesKey: aeKey
    });
    if (
      tokenAccount.data.amount !== 0n ||
      balance.pendingBalance !== 0n ||
      balance.availableBalance !== 0n
    ) {
      throw new Error(
        "This account cannot be closed yet. Resolve the displayed balance or pending operation before trying again."
      );
    }

    const emptyPlan = await getEmptyConfidentialTransferAccountInstructionPlan({
      token,
      tokenAccount: tokenAccount.data,
      authority: createNoopSigner(owner),
      elgamalKeypair,
      payer: createNoopSigner(owner),
      rpc
    });
    const emptySignatures = await executePlan(wallet, emptyPlan);
    const closedPlan = {
      kind: "single",
      planType: "instructionPlan",
      instruction: getCloseAccountInstruction({
        account: token,
        destination: owner,
        owner: createNoopSigner(owner)
      })
    } satisfies InstructionPlan;
    return [
      ...emptySignatures,
      ...(await executePlan(wallet, closedPlan))
    ];
  } finally {
    secretKey.free();
    elgamalKeypair.free();
    aeKey.free();
    keys.elgamalKeypair.secretKey.fill(0);
    keys.aeKey.fill(0);
  }
}

export async function applyConfidentialPendingBalance(
  wallet: Wallet,
  mintAddress: string,
  tokenAccountAddress: string
): Promise<string[]> {
  const rpc = createSolanaRpc(DEVNET_RPC_URL);
  const owner = address(wallet.account.address);
  const token = address(tokenAccountAddress);
  const { keys } = await deriveWalletKeys(wallet);
  const secretKey = ElGamalSecretKey.fromBytes(keys.elgamalKeypair.secretKey);
  const elgamalKeypair = ElGamalKeypair.fromSecretKey(secretKey);
  const aeKey = AeKey.fromBytes(keys.aeKey);
  try {
    const { data: tokenAccount } = await fetchToken(rpc, token);
    const instruction =
      getApplyConfidentialPendingBalanceInstructionFromToken({
        token,
        tokenAccount,
        authority: createNoopSigner(owner),
        elgamalSecretKey: secretKey,
        aesKey: aeKey
      });
    return await executePlan(wallet, {
      kind: "single",
      planType: "instructionPlan",
      instruction
    });
  } finally {
    secretKey.free();
    elgamalKeypair.free();
    aeKey.free();
    keys.elgamalKeypair.secretKey.fill(0);
    keys.aeKey.fill(0);
  }
}

export async function withdrawConfidentialBalance(
  wallet: Wallet,
  mintAddress: string,
  tokenAccountAddress: string,
  amountBaseUnits: bigint,
  decimals: number
): Promise<string[]> {
  const rpc = createSolanaRpc(DEVNET_RPC_URL);
  const owner = address(wallet.account.address);
  const token = address(tokenAccountAddress);
  const mint = address(mintAddress);
  const { keys } = await deriveWalletKeys(wallet);
  const secretKey = ElGamalSecretKey.fromBytes(keys.elgamalKeypair.secretKey);
  const elgamalKeypair = ElGamalKeypair.fromSecretKey(secretKey);
  const aeKey = AeKey.fromBytes(keys.aeKey);
  try {
    const { data: tokenAccount } = await fetchToken(rpc, token);
    const plan = await getConfidentialWithdrawInstructionPlan({
      token,
      mint,
      tokenAccount,
      authority: createNoopSigner(owner),
      amount: amountBaseUnits,
      decimals,
      elgamalKeypair,
      aesKey: aeKey,
      payer: createNoopSigner(owner),
      rpc
    });
    return await executePlan(wallet, plan);
  } finally {
    secretKey.free();
    elgamalKeypair.free();
    aeKey.free();
    keys.elgamalKeypair.secretKey.fill(0);
    keys.aeKey.fill(0);
  }
}
