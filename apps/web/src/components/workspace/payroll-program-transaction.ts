import {
  AccountRole,
  address,
  appendTransactionMessageInstructions,
  blockhash,
  compileTransaction,
  createSolanaRpc,
  createTransactionMessage,
  getAddressEncoder,
  getBase64EncodedWireTransaction,
  getProgramDerivedAddress,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  type Address
} from "@solana/kit";

const SYSTEM_PROGRAM_ADDRESS = address("11111111111111111111111111111111");
export const PAYROLL_CLAIMS_PER_TRANSACTION = 2;
const encoder = new TextEncoder();

export type PayrollClaimInput = {
  claimId: string;
  contributorAddress: string;
  amountCommitment: string;
  amountCommitmentProof: string[];
  amountCommitmentLeafIndex: number;
  escrowTokenAccount: string;
};

export type PayrollClaimTransaction = {
  claimAddresses: string[];
  claimIds: string[];
  transaction: Uint8Array;
};

export type PayrollRecoveryTransaction = {
  claimAddress: string;
  transaction: Uint8Array;
};

function decodeHex32(value: string, field: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new Error(`${field} must be a 32-byte hexadecimal value.`);
  }
  return Uint8Array.from(value.match(/.{2}/g)!, (byte) =>
    Number.parseInt(byte, 16)
  );
}

async function anchorDiscriminator(namespace: string): Promise<Uint8Array> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    encoder.encode(namespace)
  );
  return new Uint8Array(digest).slice(0, 8);
}

function concatenate(...parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(
    parts.reduce((size, part) => size + part.length, 0)
  );
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function encodeU32(value: number): Uint8Array {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error("Allocation proof index must be an unsigned 32-bit integer.");
  }
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setUint32(0, value, true);
  return bytes;
}

function encodeAnchorString(value: string): Uint8Array {
  const bytes = encoder.encode(value);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, bytes.length, true);
  return concatenate(length, bytes);
}

async function deriveWorkspaceAddress(
  authority: Address,
  workspaceSeed: Uint8Array,
  programId: Address
): Promise<Address> {
  const [workspace] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [
      encoder.encode("workspace"),
      getAddressEncoder().encode(authority),
      workspaceSeed
    ]
  });
  return workspace;
}

async function deriveClaimAddress(
  workspace: Address,
  contributor: Address,
  claimId: Uint8Array,
  programId: Address
): Promise<Address> {
  const [claim] = await getProgramDerivedAddress({
    programAddress: programId,
    seeds: [
      encoder.encode("claim"),
      getAddressEncoder().encode(workspace),
      getAddressEncoder().encode(contributor),
      claimId
    ]
  });
  return claim;
}

export async function buildPayrollClaimTransactions(input: {
  authorityAddress: string;
  workspaceId: string;
  allocationCommitment: string;
  claims: PayrollClaimInput[];
  programId: string;
  includeWorkspaceInitialization: boolean;
}): Promise<PayrollClaimTransaction[]> {
  if (input.claims.length === 0) {
    throw new Error("At least one payroll claim is required.");
  }
  if (
    new Set(input.claims.map((claim) => claim.claimId.toLowerCase())).size !==
    input.claims.length
  ) {
    throw new Error("Payroll claim identifiers must be unique.");
  }
  if (
    new Set(input.claims.map((claim) => claim.contributorAddress)).size !==
    input.claims.length
  ) {
    throw new Error("A payroll run can include each contributor only once.");
  }
  if (
    input.workspaceId.trim().length === 0 ||
    encoder.encode(input.workspaceId).length > 64
  ) {
    throw new Error("The workspace identifier must contain 1 to 64 bytes.");
  }

  const authority = address(input.authorityAddress);
  const programId = address(input.programId);
  const workspaceSeed = new Uint8Array(
    await globalThis.crypto.subtle.digest(
      "SHA-256",
      encoder.encode(`paylore:workspace:v1:${input.workspaceId}`)
    )
  );
  const allocationCommitment = decodeHex32(
    input.allocationCommitment,
    "Allocation commitment"
  );
  const workspace = await deriveWorkspaceAddress(
    authority,
    workspaceSeed,
    programId
  );
  const initData = concatenate(
    await anchorDiscriminator("global:initialize_workspace"),
    encodeAnchorString(input.workspaceId),
    workspaceSeed
  );
  const initializeWorkspace = {
    programAddress: programId,
    accounts: [
      { address: authority, role: AccountRole.WRITABLE_SIGNER },
      { address: workspace, role: AccountRole.WRITABLE },
      { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY }
    ],
    data: initData
  } as const;

  const createClaimDiscriminator = await anchorDiscriminator(
    "global:create_claim"
  );
  const claimInstructions = await Promise.all(
    input.claims.map(async (claim) => {
      const claimId = decodeHex32(claim.claimId, "Claim identifier");
      const amountCommitment = decodeHex32(claim.amountCommitment, "Amount commitment");
      if (!Array.isArray(claim.amountCommitmentProof) || claim.amountCommitmentProof.length > 16) {
        throw new Error("Allocation Merkle proof depth is invalid.");
      }
      const proofSiblings = claim.amountCommitmentProof.map((sibling) =>
        decodeHex32(sibling, "Allocation Merkle proof sibling")
      );
      const leafIndex = encodeU32(claim.amountCommitmentLeafIndex);
      const contributor = address(claim.contributorAddress);
      const claimAddress = await deriveClaimAddress(
        workspace,
        contributor,
        claimId,
        programId
      );
      return {
        claimId: claim.claimId,
        claimAddress,
        instruction: {
          programAddress: programId,
          accounts: [
            { address: authority, role: AccountRole.WRITABLE_SIGNER },
            { address: contributor, role: AccountRole.READONLY },
            { address: workspace, role: AccountRole.READONLY },
            { address: claimAddress, role: AccountRole.WRITABLE },
            { address: SYSTEM_PROGRAM_ADDRESS, role: AccountRole.READONLY }
          ],
          data: concatenate(
            createClaimDiscriminator,
            claimId,
            allocationCommitment,
            amountCommitment,
            leafIndex,
            encodeU32(proofSiblings.length),
            ...proofSiblings,
            Uint8Array.from(
              getAddressEncoder().encode(address(claim.escrowTokenAccount))
            )
          )
        } as const
      };
    })
  );

  const rpc = createSolanaRpc("https://api.devnet.solana.com");
  const claimsPerTransaction = input.claims.some((claim) => claim.amountCommitmentProof.length > 8)
    ? 1
    : PAYROLL_CLAIMS_PER_TRANSACTION;
  const batches: typeof claimInstructions[] = [];
  for (
    let index = 0;
    index < claimInstructions.length;
    index += claimsPerTransaction
  ) {
    batches.push(
      claimInstructions.slice(index, index + claimsPerTransaction)
    );
  }

  const transactions: PayrollClaimTransaction[] = [];
  for (const [index, batch] of batches.entries()) {
    const latest = await rpc
      .getLatestBlockhash({ commitment: "confirmed" })
      .send();
    const instructions = [
      ...(index === 0 && input.includeWorkspaceInitialization
        ? [initializeWorkspace]
        : []),
      ...batch.map((claim) => claim.instruction)
    ];
    const message = appendTransactionMessageInstructions(
      instructions,
      setTransactionMessageLifetimeUsingBlockhash(
        {
          blockhash: blockhash(latest.value.blockhash),
          lastValidBlockHeight: BigInt(latest.value.lastValidBlockHeight)
        },
        setTransactionMessageFeePayer(
          authority,
          createTransactionMessage({ version: 0 })
        )
      )
    );
    const wire = getBase64EncodedWireTransaction(compileTransaction(message));
    transactions.push({
      claimAddresses: batch.map((claim) => claim.claimAddress),
      claimIds: batch.map((claim) => claim.claimId),
      transaction: Uint8Array.from(atob(wire), (character) =>
        character.charCodeAt(0)
      )
    });
  }
  return transactions;
}

export async function buildPayrollRecoveryTransaction(input: {
  authorityAddress: string;
  contributorAddress: string;
  workspaceId: string;
  claimId: string;
  recoveryReasonCommitment: string;
  programId: string;
}): Promise<PayrollRecoveryTransaction> {
  const authority = address(input.authorityAddress);
  const contributor = address(input.contributorAddress);
  const programId = address(input.programId);
  const claimId = decodeHex32(input.claimId, "Claim identifier");
  const reasonCommitment = decodeHex32(
    input.recoveryReasonCommitment,
    "Recovery reason commitment"
  );
  if (reasonCommitment.every((byte) => byte === 0)) {
    throw new Error("A recovery reason commitment is required.");
  }
  const workspaceSeed = new Uint8Array(
    await globalThis.crypto.subtle.digest(
      "SHA-256",
      encoder.encode(`paylore:workspace:v1:${input.workspaceId}`)
    )
  );
  const workspace = await deriveWorkspaceAddress(
    authority,
    workspaceSeed,
    programId
  );
  const claimAddress = await deriveClaimAddress(
    workspace,
    contributor,
    claimId,
    programId
  );
  const discriminator = await anchorDiscriminator("global:recover_claim");
  const instruction = {
    programAddress: programId,
    accounts: [
      { address: authority, role: AccountRole.READONLY_SIGNER },
      { address: contributor, role: AccountRole.READONLY },
      { address: workspace, role: AccountRole.READONLY },
      { address: claimAddress, role: AccountRole.WRITABLE }
    ],
    data: concatenate(discriminator, reasonCommitment)
  } as const;
  const latest = await createSolanaRpc("https://api.devnet.solana.com")
    .getLatestBlockhash({ commitment: "confirmed" })
    .send();
  const message = appendTransactionMessageInstructions(
    [instruction],
    setTransactionMessageLifetimeUsingBlockhash(
      {
        blockhash: blockhash(latest.value.blockhash),
        lastValidBlockHeight: BigInt(latest.value.lastValidBlockHeight)
      },
      setTransactionMessageFeePayer(
        authority,
        createTransactionMessage({ version: 0 })
      )
    )
  );
  const wire = getBase64EncodedWireTransaction(compileTransaction(message));
  return {
    claimAddress,
    transaction: Uint8Array.from(atob(wire), (character) =>
      character.charCodeAt(0)
    )
  };
}
