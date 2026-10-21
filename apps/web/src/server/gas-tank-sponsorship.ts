import "server-only";

import { createHash } from "node:crypto";
import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  getSignatureFromTransaction,
  partiallySignTransactionMessageWithSigners,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash
} from "@solana/kit";
import { readSolanaRpc } from "./solana/rpc";
import {
  assertAllowedPayrollInstructionSet,
  assertSimulationSucceeded,
  assertSponsoredCost,
  GasTankSponsorshipPolicyError,
  type SponsoredClaimIntent
} from "./gas-tank-sponsorship-policy";

const SYSTEM_PROGRAM_ADDRESS = "11111111111111111111111111111111";
const ENCODER = new TextEncoder();

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function decodeHex32(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new GasTankSponsorshipPolicyError("invalid_claim_id");
  }
  return Uint8Array.from(value.match(/.{2}/g)!, (byte) => Number.parseInt(byte, 16));
}

function encodeAnchorString(value: string): Uint8Array {
  const bytes = ENCODER.encode(value);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, bytes.length, true);
  return concat(length, bytes);
}

async function discriminator(namespace: string): Promise<Uint8Array> {
  return new Uint8Array(
    createHash("sha256").update(namespace).digest().subarray(0, 8)
  );
}

async function deriveWorkspaceAddress(authority: string, workspaceSeed: Uint8Array, programId: string) {
  const [workspace] = await getProgramDerivedAddress({
    programAddress: address(programId),
    seeds: [ENCODER.encode("workspace"), getAddressEncoder().encode(address(authority)), workspaceSeed]
  });
  return workspace;
}

async function deriveClaimAddress(workspace: string, contributor: string, claimId: Uint8Array, programId: string) {
  const [claim] = await getProgramDerivedAddress({
    programAddress: address(programId),
    seeds: [
      ENCODER.encode("claim"),
      getAddressEncoder().encode(address(workspace)),
      getAddressEncoder().encode(address(contributor)),
      claimId
    ]
  });
  return claim;
}

function serializedMessageFromTransaction(wire: Uint8Array): Uint8Array {
  let cursor = 0;
  let signatureCount = 0;
  let shift = 0;
  let complete = false;
  while (cursor < wire.length && cursor < 4) {
    const byte = wire[cursor++];
    signatureCount |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) {
      complete = true;
      break;
    }
    shift += 7;
  }
  const messageOffset = cursor + signatureCount * 64;
  if (!complete || signatureCount < 1 || messageOffset >= wire.length) {
    throw new GasTankSponsorshipPolicyError("sponsored_transaction_encoding_invalid");
  }
  return wire.subarray(messageOffset);
}

export async function prepareSponsoredPayrollClaimTransaction(input: {
  workspaceId: string;
  authorityAddress: string;
  programId: string;
  gasTankAddress: string;
  gasTankPrivateKey: Uint8Array;
  balanceLamports: string;
  allocationCommitment: string;
  claims: SponsoredClaimIntent[];
  dailyBookedFeesLamports: bigint;
  dailyOperationCount: number;
}): Promise<{
  transactionBase64: string;
  signature: string;
  feeLamports: string;
  gasTankAddress: string;
  claims: Array<{ claimId: string; claimAddress: string }>;
  blockhash: string;
  lastValidBlockHeight: number;
}> {
  const secretCopy = new Uint8Array(input.gasTankPrivateKey);
  try {
    const sponsor = await createKeyPairSignerFromBytes(secretCopy);
    if (sponsor.address !== input.gasTankAddress) {
      throw new GasTankSponsorshipPolicyError("gas_tank_key_identity_mismatch");
    }
    const authority = address(input.authorityAddress);
    const programId = address(input.programId);
    const workspaceSeed = new Uint8Array(
      createHash("sha256").update(`paylore:workspace:v1:${input.workspaceId}`).digest()
    );
    const workspace = await deriveWorkspaceAddress(authority, workspaceSeed, programId);
    const allocationCommitment = decodeHex32(input.allocationCommitment);
    const initializeDiscriminator = await discriminator("global:initialize_workspace");
    const createClaimDiscriminator = await discriminator("global:create_claim");

    const initializeInstruction = {
      programAddress: programId,
      accounts: [
        { address: authority, role: AccountRole.WRITABLE_SIGNER },
        { address: workspace, role: AccountRole.WRITABLE },
        { address: address(SYSTEM_PROGRAM_ADDRESS), role: AccountRole.READONLY }
      ],
      data: concat(
        initializeDiscriminator,
        encodeAnchorString(input.workspaceId),
        workspaceSeed
      )
    } as const;

    const derivedClaims = await Promise.all(input.claims.map(async (claim) => {
      const claimIdBytes = decodeHex32(claim.claimId);
      const contributor = address(claim.contributorAddress);
      const claimAddress = await deriveClaimAddress(workspace, contributor, claimIdBytes, programId);
      if (claimAddress !== claim.claimAddress) {
        throw new GasTankSponsorshipPolicyError("sponsored_claim_address_mismatch");
      }
      return {
        ...claim,
        contributor: contributor,
        claimAddress: claimAddress,
        instruction: {
          programAddress: programId,
          accounts: [
            { address: authority, role: AccountRole.WRITABLE_SIGNER },
            { address: contributor, role: AccountRole.READONLY },
            { address: workspace, role: AccountRole.READONLY },
            { address: claimAddress, role: AccountRole.WRITABLE },
            { address: address(SYSTEM_PROGRAM_ADDRESS), role: AccountRole.READONLY }
          ],
          data: concat(createClaimDiscriminator, claimIdBytes, allocationCommitment)
        } as const
      };
    }));

    const accountAddresses = [workspace, ...derivedClaims.map((claim) => claim.claimAddress)];
    const existing = await readSolanaRpc<{
      value: Array<{ owner?: string; data?: unknown } | null>
    }>(
      "getMultipleAccounts",
      [accountAddresses, {
        commitment: "finalized",
        encoding: "base64"
      }]
    );
    if (!Array.isArray(existing.value) || existing.value.length !== accountAddresses.length) {
      throw new GasTankSponsorshipPolicyError("sponsored_claim_state_unavailable");
    }
    const existingWorkspace = existing.value[0];
    if (existingWorkspace && existingWorkspace.owner !== input.programId) {
      throw new GasTankSponsorshipPolicyError("sponsored_workspace_pda_owner_mismatch");
    }
    if (existing.value.slice(1).some((account) => account !== null)) {
      throw new GasTankSponsorshipPolicyError("sponsored_claim_already_exists");
    }

    const instructionPlan = [
      ...(!existingWorkspace ? [initializeInstruction] : []),
      ...derivedClaims.map((claim) => claim.instruction)
    ];
    assertAllowedPayrollInstructionSet({
      instructions: instructionPlan,
      programId,
      authorityAddress: authority,
      workspaceId: input.workspaceId,
      workspaceAddress: workspace,
      allocationCommitment: input.allocationCommitment,
      workspaceSeed,
      claims: derivedClaims.map(({ claimId, contributorAddress, claimAddress }) => ({
        claimId,
        contributorAddress,
        claimAddress
      })),
      initializeDiscriminator,
      createClaimDiscriminator,
      includeWorkspaceInitialization: !existingWorkspace,
      systemProgramAddress: SYSTEM_PROGRAM_ADDRESS
    });

    const latest = await readSolanaRpc<{
      value: { blockhash: string; lastValidBlockHeight: number }
    }>("getLatestBlockhash", [{ commitment: "confirmed" }]);
    const message = appendTransactionMessageInstructions(
      instructionPlan,
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash(latest.value.blockhash),
          lastValidBlockHeight: BigInt(latest.value.lastValidBlockHeight)
        },
        setTransactionMessageFeePayerSigner(
          sponsor,
          createTransactionMessage({ version: 0 })
        )
      )
    );
    const partiallySigned = await partiallySignTransactionMessageWithSigners(message);
    const wireBase64 = getBase64EncodedWireTransaction(partiallySigned);
    const wireBytes = Uint8Array.from(Buffer.from(wireBase64, "base64"));
    const serializedMessage = serializedMessageFromTransaction(wireBytes);
    const fee = await readSolanaRpc<{ value: number | null }>(
      "getFeeForMessage",
      [Buffer.from(serializedMessage).toString("base64"), { commitment: "confirmed" }]
    );
    if (fee.value === null || !Number.isSafeInteger(fee.value) || fee.value < 0) {
      throw new GasTankSponsorshipPolicyError("sponsored_fee_unavailable");
    }
    assertSponsoredCost({
      transactionBytes: wireBytes.length,
      feeLamports: BigInt(fee.value),
      balanceLamports: BigInt(input.balanceLamports),
      dailyBookedFeesLamports: input.dailyBookedFeesLamports,
      dailyOperationCount: input.dailyOperationCount
    });

    const simulation = await readSolanaRpc<unknown>("simulateTransaction", [
      wireBase64,
      {
        encoding: "base64",
        commitment: "confirmed",
        sigVerify: false,
        replaceRecentBlockhash: true,
        innerInstructions: false
      }
    ]);
    assertSimulationSucceeded(simulation);
    const signature = String(getSignatureFromTransaction(partiallySigned));
    return {
      transactionBase64: wireBase64,
      signature,
      feeLamports: String(fee.value),
      gasTankAddress: input.gasTankAddress,
      claims: derivedClaims.map(({ claimId, claimAddress }) => ({ claimId, claimAddress })),
      blockhash: latest.value.blockhash,
      lastValidBlockHeight: latest.value.lastValidBlockHeight
    };
  } finally {
    secretCopy.fill(0);
  }
}
