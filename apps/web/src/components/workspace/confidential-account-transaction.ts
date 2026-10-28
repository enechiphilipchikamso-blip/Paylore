"use client";

import {
  getCreateConfidentialTransferAccountInstructionPlan,
  fetchConfidentialTransferBalance,
  getApplyConfidentialPendingBalanceInstructionFromToken,
  getEmptyConfidentialTransferAccountInstructionPlan,
  getConfidentialWithdrawInstructionPlan
} from "@solana-program/token-2022/confidential";
import { getConfidentialAccountClosureBlocker } from "./confidential-account-closure-policy";
import {
  assertConfidentialAccountAutoApproval,
  assertExactConfidentialWithdrawal
} from "./confidential-operation-sequence";
import { buildWrappedUsdcUnwrapPlan } from "./token-wrap-transaction";
import {
  assertDevnetTokenWrapIdentity,
  assertDevnetTokenWrapProgramAccount,
  assertExactFinalizedUnwrapBalances,
  assertExpectedAssociatedTokenAccount
} from "./token-wrap-compatibility";
import {
  TOKEN_2022_PROGRAM_ADDRESS,
  TOKEN_PROGRAM_ADDRESS,
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
  AccountRole,
  address,
  appendTransactionMessageInstruction,
  blockhash,
  createNoopSigner,
  createSolanaRpc,
  getTransactionDecoder,
  createTransactionMessage,
  createTransactionPlanExecutorWithConcurrentLeaves,
  createTransactionPlanner,
  fetchEncodedAccount,
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
const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const SETUP_AUTHORIZATION_MEMO = new TextEncoder().encode(
  "Paylore confidential-account setup authorization"
);

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

async function executePlan(
  wallet: Wallet,
  plan: InstructionPlan,
  sponsorship?: { feePayerAddress: string; relayUrl: string },
  simulation?: { only: boolean }
): Promise<string[]> {
  const rpc = createSolanaRpc(DEVNET_RPC_URL);
  const owner = address(wallet.account.address);
  const feePayer = createNoopSigner(
    sponsorship ? address(sponsorship.feePayerAddress) : owner
  );
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
      const contributorAlreadySigns = message.instructions.some((instruction) =>
        instruction.accounts?.some((account) =>
          account.address === owner &&
          (account.role === AccountRole.READONLY_SIGNER ||
            account.role === AccountRole.WRITABLE_SIGNER)
        )
      );
      const authorizedMessage = sponsorship && !contributorAlreadySigns
        ? appendTransactionMessageInstruction({
            programAddress: address(MEMO_PROGRAM_ADDRESS),
            accounts: [{ address: owner, role: AccountRole.READONLY_SIGNER }],
            data: SETUP_AUTHORIZATION_MEMO
          }, message)
        : message;
      const partiallySigned =
        await partiallySignTransactionMessageWithSigners(authorizedMessage);
      const encoded = getBase64EncodedWireTransaction(partiallySigned);
      const transaction = Uint8Array.from(atob(encoded), (character) =>
        character.charCodeAt(0)
      );
      if (simulation) {
        const result = await rpc.simulateTransaction(encoded, {
          encoding: "base64", commitment: "confirmed", sigVerify: false, replaceRecentBlockhash: true
        }).send();
        if (result.value.err !== null) throw new Error("The configured Token Wrap program failed read-only simulation. No transaction was submitted.");
        if (simulation.only) return { signature: signature("1".repeat(64)) };
      }
      if (sponsorship) {
        if (!wallet.signTransaction) {
          throw new Error(
            "This wallet cannot partially authorize company-sponsored confidential-account setup. No sponsored transaction was sent."
          );
        }
        const [signed] = await wallet.signTransaction({
          account: wallet.account,
          chain: "solana:devnet",
          transaction,
          options: { preflightCommitment: "confirmed" }
        });
        const originalDecoded = getTransactionDecoder().decode(transaction);
        const signedDecoded = getTransactionDecoder().decode(signed.signedTransaction);
        if (!sameBytes(
          Uint8Array.from(originalDecoded.messageBytes),
          Uint8Array.from(signedDecoded.messageBytes)
        )) {
          throw new Error(
            "The wallet changed the sponsored transaction after authorization. No transaction was submitted."
          );
        }
        if (!signedDecoded.signatures[owner] ||
            signedDecoded.signatures[owner]!.every((byte) => byte === 0)) {
          throw new Error(
            "The wallet did not authorize the confidential-account setup transaction."
          );
        }
        const transactionBase64 = btoa(
          Array.from(signed.signedTransaction, (byte) =>
            String.fromCharCode(byte)
          ).join("")
        );
        const submit = async () => fetch(sponsorship.relayUrl, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ transactionBase64 })
        });
        let response = await submit();
        let result = await response.json();
        if ((response.ok || response.status === 202) &&
            typeof result.signature === "string") {
          const submittedSignature = signature(getBase58Decoder().decode(result.signature));
          await waitForFinality(rpc, submittedSignature);
          response = await submit();
          result = await response.json();
        }
        if (!response.ok || typeof result.signature !== "string" || result.status !== "finalized") {
          throw new Error(
            result.error === "gas_tank_insufficient_balance"
              ? "The workspace Gas Tank cannot cover the sponsored setup cost. Ask the workspace administrator to fund it; your wallet was not charged for setup."
              : result.error === "confidential_setup_sponsorship_unavailable"
                ? "Company-sponsored setup is unavailable under the workspace's current sponsorship policy. No contributor-paid fallback was used."
                : result.error === "confidential_setup_sponsorship_pending" || response.status === 202
                  ? "The sponsored transaction is still awaiting network finality. Refresh this account's status before trying setup again."
                  : "Company-sponsored account setup could not be reconciled. Keep the setup screen open and retry verification before starting another setup."
          );
        }
        const encodedSignature = getBase58Decoder().decode(result.signature);
        const transactionSignature = signature(encodedSignature);
        signatures.push(result.signature);
        return { signature: transactionSignature };
      }
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
      throw new Error("The confidential-account transaction failed on Solana.");
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
  mintAddress: string,
  sponsorship: { feePayerAddress: string; relayUrl: string }
): Promise<{ tokenAccountAddress: string; signature: string }> {
  const rpc = createSolanaRpc(DEVNET_RPC_URL);
  const mint = address(mintAddress);
  const mintAccount = await fetchMint(rpc, mint);
  const mintExtensions = isSome(mintAccount.data.extensions)
    ? mintAccount.data.extensions.value
    : [];
  requireConfidentialMintExtensions(mintExtensions);
  const confidentialTransferMint = mintExtensions.find(
    (extension) => extension.__kind === "ConfidentialTransferMint"
  ) as { autoApproveNewAccounts?: boolean } | undefined;
  assertConfidentialAccountAutoApproval({
    confidentialTransferExtensionPresent: confidentialTransferMint !== undefined,
    autoApproveNewAccounts: confidentialTransferMint?.autoApproveNewAccounts === true
  });
  const includeConfidentialTransferFeeAmount = mintExtensions.some(
    (extension) => extension.__kind === "TransferFeeConfig"
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
      payer: createNoopSigner(address(sponsorship.feePayerAddress)),
      owner: createNoopSigner(owner),
      mint,
      token: tokenAccount,
      rpc,
      elgamalKeypair,
      aesKey: aeKey,
      includeConfidentialTransferFeeAmount
    });
    const signatures = await executePlan(wallet, plan, sponsorship);
    const signature = signatures.at(-1);
    if (!signature) {
      throw new Error("Company-sponsored setup did not produce a transaction signature.");
    }
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
  tokenAccountAddress: string,
  eligibility: { ownerWalletAddress: string; accountStatus: string; hasOpenAllocations: boolean }
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
    const blocker = getConfidentialAccountClosureBlocker({
      connectedWalletAddress: owner,
      ownerWalletAddress: eligibility.ownerWalletAddress,
      accountStatus: eligibility.accountStatus,
      hasOpenAllocations: eligibility.hasOpenAllocations,
      publicBalance: tokenAccount.data.amount,
      pendingBalance: balance.pendingBalance,
      availableBalance: balance.availableBalance
    });
    if (blocker) {
      const messages: Record<typeof blocker, string> = {
        confidential_account_owner_mismatch: "The connected wallet does not own this confidential account.",
        confidential_account_not_ready: "This confidential account is not verified as ready to close.",
        outstanding_compensation_obligation: "This account cannot be closed while qualifying compensation obligations remain.",
        confidential_balance_unavailable: "The account balances could not be verified. Refresh the balance and try again.",
        confidential_account_balance_not_zero: "This account cannot be closed yet. Resolve all public, pending and available balances before trying again."
      };
      throw new Error(messages[blocker]);
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
    if (amountBaseUnits <= 0n) {
      throw new Error("Enter a positive amount to withdraw.");
    }
    const { data: tokenAccount } = await fetchToken(rpc, token);
    const confidentialBefore = await fetchConfidentialTransferBalance({
      token, rpc, elgamalSecretKey: secretKey, aesKey: aeKey
    });
    if (confidentialBefore.availableBalance < amountBaseUnits) {
      throw new Error("The available confidential balance is lower than the requested withdrawal. Apply pending funds first if needed.");
    }
    const publicBefore = await readFinalizedTokenAccountBalance(rpc, token);
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
    const signatures = await executePlan(wallet, plan);
    const transactionSignature = signatures.at(-1);
    if (!transactionSignature) {
      throw new Error("The confidential withdrawal did not return a transaction signature.");
    }
    try {
      const confidentialAfter = await fetchConfidentialTransferBalance({
        token, rpc, elgamalSecretKey: secretKey, aesKey: aeKey
      });
      const publicAfter = await readFinalizedTokenAccountBalance(rpc, token);
      assertExactConfidentialWithdrawal({
        amountBaseUnits,
        availableBefore: confidentialBefore.availableBalance,
        availableAfter: confidentialAfter.availableBalance,
        publicBefore,
        publicAfter,
        transactionSignature
      });
    } catch (error) {
      throw new Error(
        `The withdrawal transaction finalized, but the exact confidential debit and public-token credit could not be reconciled. Do not submit a duplicate withdrawal. Transaction: ${transactionSignature}`,
        { cause: error }
      );
    }
    return signatures;
  } finally {
    secretKey.free();
    elgamalKeypair.free();
    aeKey.free();
    keys.elgamalKeypair.secretKey.fill(0);
    keys.aeKey.fill(0);
  }
}

async function readFinalizedTokenAccountBalance(
  rpc: ReturnType<typeof createSolanaRpc>,
  tokenAccountAddress: string
): Promise<bigint> {
  const result = await rpc
    .getTokenAccountBalance(address(tokenAccountAddress), { commitment: "finalized" })
    .send();
  if (!/^\d+$/.test(result.value.amount)) {
    throw new Error("The finalized token-account balance response was invalid.");
  }
  return BigInt(result.value.amount);
}

type WrappedUsdcUnwrapPreflight = {
  plan: InstructionPlan;
  sourceTokenAccount: string;
  destinationTokenAccount: string;
  unwrappedEscrow: string;
  sourceBalanceBefore: bigint;
  destinationBalanceBefore: bigint;
};

export async function verifyWrappedUsdcUnwrapCompatibility(
  wallet: Wallet,
  wrappedMintAddress: string,
  unwrappedMintAddress: string,
  tokenWrapProgramAddress: string,
  amountBaseUnits: bigint
): Promise<void> {
  await verifyWrappedUsdcUnwrapPlan(
    wallet,
    wrappedMintAddress,
    unwrappedMintAddress,
    tokenWrapProgramAddress,
    amountBaseUnits
  );
}

async function verifyWrappedUsdcUnwrapPlan(
  wallet: Wallet,
  wrappedMintAddress: string,
  unwrappedMintAddress: string,
  tokenWrapProgramAddress: string,
  amountBaseUnits: bigint
): Promise<WrappedUsdcUnwrapPreflight> {
  const rpc = createSolanaRpc(DEVNET_RPC_URL);
  const owner = address(wallet.account.address);
  const programAddress = address(tokenWrapProgramAddress);
  const wrappedMint = address(wrappedMintAddress);
  const unwrappedMint = address(unwrappedMintAddress);

  const program = await fetchEncodedAccount(rpc, programAddress);
  assertDevnetTokenWrapProgramAccount({
    programAddress: tokenWrapProgramAddress,
    ownerProgramAddress: program.exists ? program.programAddress : "",
    executable: program.exists && program.executable === true
  });

  const wrappedMintAccount = await fetchEncodedAccount(rpc, wrappedMint);
  const unwrappedMintAccount = await fetchEncodedAccount(rpc, unwrappedMint);
  if (
    !wrappedMintAccount.exists ||
    wrappedMintAccount.programAddress !== TOKEN_2022_PROGRAM_ADDRESS
  ) {
    throw new Error(
      "The approved wrapped-USDC mint is missing or is not owned by Token-2022. No transaction was submitted."
    );
  }
  if (
    !unwrappedMintAccount.exists ||
    unwrappedMintAccount.programAddress !== TOKEN_PROGRAM_ADDRESS
  ) {
    throw new Error(
      "Circle Devnet USDC is missing or is not owned by the classic SPL Token program. No transaction was submitted."
    );
  }

  const built = await buildWrappedUsdcUnwrapPlan({
    ownerAddress: owner,
    wrappedMintAddress,
    unwrappedMintAddress,
    tokenWrapProgramAddress,
    amount: amountBaseUnits
  });
  const [wrappedSupply, unwrappedSupply] = await Promise.all([
    rpc.getTokenSupply(wrappedMint, { commitment: "finalized" }).send(),
    rpc.getTokenSupply(unwrappedMint, { commitment: "finalized" }).send()
  ]);
  const wrappedMintData = await fetchMint(rpc, wrappedMint);
  assertDevnetTokenWrapIdentity({
    programAddress: tokenWrapProgramAddress,
    wrappedMintAddress,
    unwrappedMintAddress,
    wrappedMintProgramAddress: wrappedMintAccount.programAddress,
    unwrappedMintProgramAddress: unwrappedMintAccount.programAddress,
    derivedWrappedMintAddress: built.expectedWrappedMintAddress,
    wrappedMintDecimals: wrappedSupply.value.decimals,
    unwrappedMintDecimals: unwrappedSupply.value.decimals
  });
  requireConfidentialMintExtensions(
    isSome(wrappedMintData.data.extensions)
      ? wrappedMintData.data.extensions.value
      : []
  );

  const [expectedSourceTokenAccount] = await findAssociatedTokenPda({
    owner,
    mint: wrappedMint,
    tokenProgram: TOKEN_2022_PROGRAM_ADDRESS
  });
  const [expectedDestinationTokenAccount] = await findAssociatedTokenPda({
    owner,
    mint: unwrappedMint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS
  });
  if (built.sourceTokenAccount !== expectedSourceTokenAccount) {
    throw new Error(
      "The wrapped-USDC source is not the connected wallet's deterministic Token-2022 account. No transaction was submitted."
    );
  }
  assertExpectedAssociatedTokenAccount({
    tokenAccountAddress: built.destinationTokenAccount,
    expectedTokenAccountAddress: expectedDestinationTokenAccount,
    tokenAccountProgramAddress: TOKEN_PROGRAM_ADDRESS,
    expectedTokenProgramAddress: TOKEN_PROGRAM_ADDRESS,
    tokenAccountOwnerAddress: owner,
    expectedOwnerAddress: owner,
    tokenAccountMintAddress: unwrappedMint,
    expectedMintAddress: unwrappedMint
  });

  const sourceAccountInfo = await fetchEncodedAccount(
    rpc,
    address(built.sourceTokenAccount)
  );
  if (
    !sourceAccountInfo.exists ||
    sourceAccountInfo.programAddress !== TOKEN_2022_PROGRAM_ADDRESS
  ) {
    throw new Error(
      "The public wrapped-USDC source account is missing or uses the wrong token program. No transaction was submitted."
    );
  }
  const source = (await fetchToken(rpc, address(built.sourceTokenAccount))).data;
  if (source.owner !== owner || source.mint !== wrappedMint) {
    throw new Error(
      "The public wrapped-USDC source account does not belong to this wallet and mint. No transaction was submitted."
    );
  }
  const sourceBalanceBefore = await readFinalizedTokenAccountBalance(
    rpc,
    built.sourceTokenAccount
  );
  if (sourceBalanceBefore < amountBaseUnits) {
    throw new Error(
      "The finalized public wrapped-USDC balance is lower than the requested unwrap amount. No transaction was submitted."
    );
  }

  const escrowInfo = await fetchEncodedAccount(
    rpc,
    address(built.unwrappedEscrow)
  );
  if (!escrowInfo.exists || escrowInfo.programAddress !== TOKEN_PROGRAM_ADDRESS) {
    throw new Error(
      "The Token Wrap escrow account is missing or uses the wrong token program. No transaction was submitted."
    );
  }
  const escrow = (await fetchToken(rpc, address(built.unwrappedEscrow))).data;
  if (
    escrow.owner !== address(built.wrappedMintAuthority) ||
    escrow.mint !== unwrappedMint
  ) {
    throw new Error(
      "The Token Wrap escrow does not match the wrapped-mint authority and Circle Devnet USDC mint. No transaction was submitted."
    );
  }
  const escrowBalance = await readFinalizedTokenAccountBalance(
    rpc,
    built.unwrappedEscrow
  );
  if (escrowBalance < amountBaseUnits) {
    throw new Error(
      "The Token Wrap escrow cannot cover the requested Circle-USDC release. No transaction was submitted."
    );
  }

  const destinationInfo = await fetchEncodedAccount(
    rpc,
    address(built.destinationTokenAccount)
  );
  let destinationBalanceBefore = 0n;
  if (destinationInfo.exists) {
    if (destinationInfo.programAddress !== TOKEN_PROGRAM_ADDRESS) {
      throw new Error(
        "The existing Circle-USDC destination is not owned by the classic SPL Token program. No transaction was submitted."
      );
    }
    const destination = (await fetchToken(
      rpc,
      address(built.destinationTokenAccount)
    )).data;
    assertExpectedAssociatedTokenAccount({
      tokenAccountAddress: built.destinationTokenAccount,
      expectedTokenAccountAddress: expectedDestinationTokenAccount,
      tokenAccountProgramAddress: destinationInfo.programAddress,
      expectedTokenProgramAddress: TOKEN_PROGRAM_ADDRESS,
      tokenAccountOwnerAddress: destination.owner,
      expectedOwnerAddress: owner,
      tokenAccountMintAddress: destination.mint,
      expectedMintAddress: unwrappedMint
    });
    destinationBalanceBefore = await readFinalizedTokenAccountBalance(
      rpc,
      built.destinationTokenAccount
    );
  }

  // A successful simulation of this exact SDK-generated plan is the on-chain ABI gate for the deployed fork.
  await executePlan(wallet, built.plan, undefined, { only: true });
  return {
    plan: built.plan,
    sourceTokenAccount: built.sourceTokenAccount,
    destinationTokenAccount: built.destinationTokenAccount,
    unwrappedEscrow: built.unwrappedEscrow,
    sourceBalanceBefore,
    destinationBalanceBefore
  };
}

export async function unwrapWrappedUsdcToCircleUsdc(
  wallet: Wallet,
  wrappedMintAddress: string,
  unwrappedMintAddress: string,
  tokenWrapProgramAddress: string,
  amountBaseUnits: bigint
): Promise<{ signature: string; recipientTokenAccount: string }> {
  const rpc = createSolanaRpc(DEVNET_RPC_URL);
  const preflight = await verifyWrappedUsdcUnwrapPlan(
    wallet,
    wrappedMintAddress,
    unwrappedMintAddress,
    tokenWrapProgramAddress,
    amountBaseUnits
  );

  const signatures = await executePlan(
    wallet,
    preflight.plan,
    undefined,
    { only: false }
  );
  const transactionSignature = signatures.at(-1);
  if (!transactionSignature) {
    throw new Error("The Token Wrap transaction did not return a signature.");
  }

  try {
    const sourceInfo = await fetchEncodedAccount(
      rpc,
      address(preflight.sourceTokenAccount)
    );
    const destinationInfo = await fetchEncodedAccount(
      rpc,
      address(preflight.destinationTokenAccount)
    );
    if (
      !sourceInfo.exists ||
      sourceInfo.programAddress !== TOKEN_2022_PROGRAM_ADDRESS ||
      !destinationInfo.exists ||
      destinationInfo.programAddress !== TOKEN_PROGRAM_ADDRESS
    ) {
      throw new Error("A finalized token account is missing or owned by the wrong token program.");
    }

    const [sourceAfter, destinationAfter] = await Promise.all([
      fetchToken(rpc, address(preflight.sourceTokenAccount)),
      fetchToken(rpc, address(preflight.destinationTokenAccount))
    ]);
    assertExpectedAssociatedTokenAccount({
      tokenAccountAddress: preflight.destinationTokenAccount,
      expectedTokenAccountAddress: preflight.destinationTokenAccount,
      tokenAccountProgramAddress: destinationInfo.programAddress,
      expectedTokenProgramAddress: TOKEN_PROGRAM_ADDRESS,
      tokenAccountOwnerAddress: destinationAfter.data.owner,
      expectedOwnerAddress: address(wallet.account.address),
      tokenAccountMintAddress: destinationAfter.data.mint,
      expectedMintAddress: address(unwrappedMintAddress)
    });
    if (
      sourceAfter.data.owner !== address(wallet.account.address) ||
      sourceAfter.data.mint !== address(wrappedMintAddress)
    ) {
      throw new Error("The finalized wrapped-USDC source identity changed.");
    }

    const [sourceBalanceAfter, destinationBalanceAfter] = await Promise.all([
      readFinalizedTokenAccountBalance(rpc, preflight.sourceTokenAccount),
      readFinalizedTokenAccountBalance(rpc, preflight.destinationTokenAccount)
    ]);
    assertExactFinalizedUnwrapBalances({
      amountBaseUnits,
      sourceBalanceBefore: preflight.sourceBalanceBefore,
      sourceBalanceAfter,
      destinationBalanceBefore: preflight.destinationBalanceBefore,
      destinationBalanceAfter,
      transactionSignature
    });
  } catch (error) {
    throw new Error(
      `The Token Wrap transaction finalized, but its exact wrapped-token debit and Circle-USDC credit could not be reconciled. Do not submit a duplicate unwrap. Transaction: ${transactionSignature}`,
      { cause: error }
    );
  }

  return {
    signature: transactionSignature,
    recipientTokenAccount: preflight.destinationTokenAccount
  };
}
