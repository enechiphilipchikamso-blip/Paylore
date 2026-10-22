import {
  AccountRole,
  getAddressDecoder
} from "@solana/kit";

export const MAX_SPONSORED_CLAIMS = 4;
export const MAX_SPONSORED_TRANSACTION_BYTES = 1_232;
export const MAX_SPONSORED_FEE_LAMPORTS = 100_000n;
export const MAX_DAILY_SPONSORED_FEE_LAMPORTS = 5_000_000n;
export const MAX_DAILY_SPONSORED_OPERATIONS = 100;
export const MAX_SIMULATED_COMPUTE_UNITS = 1_400_000;
const TEXT = new TextEncoder();

export type SponsoredClaimIntent = {
  claimId: string;
  contributorAddress: string;
  claimAddress?: string;
};

export class GasTankSponsorshipPolicyError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "GasTankSponsorshipPolicyError";
  }
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length &&
    left.every((value, index) => value === right[index]);
}

function hex32(value: string): Uint8Array {
  if (!/^[0-9a-f]{64}$/i.test(value)) {
    throw new GasTankSponsorshipPolicyError("invalid_claim_id");
  }
  return Uint8Array.from(value.match(/.{2}/g)!, (part) =>
    Number.parseInt(part, 16)
  );
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const output = new Uint8Array(parts.reduce((size, part) => size + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    output.set(part, offset);
    offset += part.length;
  }
  return output;
}

function encodeString(value: string): Uint8Array {
  const bytes = TEXT.encode(value);
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, bytes.length, true);
  return concat(length, bytes);
}

function expectInstructionAccount(
  actual: unknown,
  expectedAddress: string,
  expectedRole: AccountRole
): boolean {
  if (!actual || typeof actual !== "object") return false;
  const account = actual as { address?: unknown; role?: unknown };
  return account.address === expectedAddress && account.role === expectedRole;
}

export function assertSponsoredClaimIntent(input: {
  operation: string;
  workspaceId: string;
  requestedWorkspaceId: string;
  sessionWallet: string | null;
  authorityAddress: string;
  managerConfirmed: boolean;
  runCommitment: string | null;
  claims: SponsoredClaimIntent[];
}): void {
  if (input.operation !== "payroll_claim_commitment") {
    throw new GasTankSponsorshipPolicyError("sponsored_operation_not_allowed");
  }
  if (
    !input.workspaceId ||
    input.workspaceId !== input.requestedWorkspaceId
  ) {
    throw new GasTankSponsorshipPolicyError("sponsored_workspace_mismatch");
  }
  if (!input.sessionWallet || input.sessionWallet !== input.authorityAddress) {
    throw new GasTankSponsorshipPolicyError("sponsored_authority_mismatch");
  }
  if (!input.managerConfirmed || !input.runCommitment || !/^[0-9a-f]{64}$/i.test(input.runCommitment)) {
    throw new GasTankSponsorshipPolicyError("payroll_run_not_confirmed");
  }
  if (!Array.isArray(input.claims) ||
      input.claims.length < 1 ||
      input.claims.length > MAX_SPONSORED_CLAIMS) {
    throw new GasTankSponsorshipPolicyError("sponsored_claim_count_invalid");
  }
  if (
    new Set(input.claims.map((claim) => claim.claimId.toLowerCase())).size !==
    input.claims.length ||
    new Set(input.claims.map((claim) => claim.contributorAddress)).size !==
    input.claims.length
  ) {
    throw new GasTankSponsorshipPolicyError("sponsored_claims_duplicate");
  }
  for (const claim of input.claims) {
    hex32(claim.claimId);
    if (!claim.contributorAddress ||
        (claim.claimAddress !== undefined && !claim.claimAddress)) {
      throw new GasTankSponsorshipPolicyError("sponsored_claim_mapping_invalid");
    }
  }
}

export function assertAllowedPayrollInstructionSet(input: {
  instructions: readonly unknown[];
  programId: string;
  authorityAddress: string;
  workspaceId: string;
  workspaceAddress: string;
  allocationCommitment: string;
  workspaceSeed: Uint8Array;
  claims: SponsoredClaimIntent[];
  initializeDiscriminator: Uint8Array;
  includeWorkspaceInitialization?: boolean;
  createClaimDiscriminator: Uint8Array;
  systemProgramAddress: string;
}): void {
  const commitment = hex32(input.allocationCommitment);
  const includeWorkspaceInitialization = input.includeWorkspaceInitialization ?? true;
  const expectedInstructionCount = input.claims.length + Number(includeWorkspaceInitialization);
  if (input.instructions.length !== expectedInstructionCount) {
    throw new GasTankSponsorshipPolicyError("sponsored_instruction_count_invalid");
  }
  if (includeWorkspaceInitialization) {
    const init = input.instructions[0] as {
    programAddress?: unknown;
    accounts?: unknown;
    data?: unknown;
  } | undefined;
  if (
    !init ||
    init.programAddress !== input.programId ||
    !Array.isArray(init.accounts) ||
    init.accounts.length !== 3 ||
    !(init.data instanceof Uint8Array) ||
    !bytesEqual(
      init.data,
      concat(
        input.initializeDiscriminator,
        encodeString(input.workspaceId),
        input.workspaceSeed
      )
    ) ||
    !expectInstructionAccount(init.accounts[0], input.authorityAddress, AccountRole.WRITABLE_SIGNER) ||
    !expectInstructionAccount(init.accounts[1], input.workspaceAddress, AccountRole.WRITABLE) ||
    !expectInstructionAccount(init.accounts[2], input.systemProgramAddress, AccountRole.READONLY)
  ) {
      throw new GasTankSponsorshipPolicyError("sponsored_initialize_instruction_denied");
    }
  }

  const claimInstructionOffset = Number(includeWorkspaceInitialization);
  for (const [index, claim] of input.claims.entries()) {
    const instruction = input.instructions[index + claimInstructionOffset] as {
      programAddress?: unknown;
      accounts?: unknown;
      data?: unknown;
    } | undefined;
    if (
      !instruction ||
      instruction.programAddress !== input.programId ||
      !Array.isArray(instruction.accounts) ||
      instruction.accounts.length !== 5 ||
      !(instruction.data instanceof Uint8Array) ||
      !bytesEqual(
        instruction.data,
        concat(
          input.createClaimDiscriminator,
          hex32(claim.claimId),
          commitment
        )
      ) ||
      !expectInstructionAccount(instruction.accounts[0], input.authorityAddress, AccountRole.WRITABLE_SIGNER) ||
      !expectInstructionAccount(instruction.accounts[1], claim.contributorAddress, AccountRole.READONLY) ||
      !expectInstructionAccount(instruction.accounts[2], input.workspaceAddress, AccountRole.READONLY) ||
      !expectInstructionAccount(instruction.accounts[3], claim.claimAddress!, AccountRole.WRITABLE) ||
      !expectInstructionAccount(instruction.accounts[4], input.systemProgramAddress, AccountRole.READONLY)
    ) {
      throw new GasTankSponsorshipPolicyError("sponsored_claim_instruction_denied");
    }
  }
}

export function assertSponsoredCost(input: {
  transactionBytes: number;
  feeLamports: bigint;
  balanceLamports: bigint;
  dailyBookedFeesLamports: bigint;
  dailyOperationCount: number;
}): void {
  if (
    input.balanceLamports < 0n ||
    input.dailyBookedFeesLamports < 0n ||
    !Number.isSafeInteger(input.dailyOperationCount) ||
    input.dailyOperationCount < 0
  ) {
    throw new GasTankSponsorshipPolicyError("sponsored_budget_evidence_invalid");
  }
  if (
    !Number.isInteger(input.transactionBytes) ||
    input.transactionBytes < 1 ||
    input.transactionBytes > MAX_SPONSORED_TRANSACTION_BYTES
  ) {
    throw new GasTankSponsorshipPolicyError("sponsored_transaction_size_exceeded");
  }
  if (input.feeLamports < 0n || input.feeLamports > MAX_SPONSORED_FEE_LAMPORTS) {
    throw new GasTankSponsorshipPolicyError("sponsored_fee_limit_exceeded");
  }
  if (input.balanceLamports < input.feeLamports) {
    throw new GasTankSponsorshipPolicyError("gas_tank_insufficient_balance");
  }
  if (
    input.dailyOperationCount >= MAX_DAILY_SPONSORED_OPERATIONS ||
    input.dailyBookedFeesLamports + input.feeLamports >
      MAX_DAILY_SPONSORED_FEE_LAMPORTS
  ) {
    throw new GasTankSponsorshipPolicyError("gas_tank_daily_sponsorship_limit");
  }
}

export type PreparedSponsorshipState = "live" | "submitted_pending" | "finalized_success" | "finalized_failure" | "expired";

/** Only an absent signature past the last valid block height can release a prepared fee reservation. */
export function classifyPreparedSponsorshipState(input: {
  currentBlockHeight: number;
  lastValidBlockHeight: number;
  signatureStatus: { confirmationStatus?: string | null; err?: unknown } | null;
}): PreparedSponsorshipState {
  if (!Number.isSafeInteger(input.currentBlockHeight) || input.currentBlockHeight < 0 ||
      !Number.isSafeInteger(input.lastValidBlockHeight) || input.lastValidBlockHeight < 0) {
    throw new GasTankSponsorshipPolicyError("sponsorship_block_height_invalid");
  }
  if (input.signatureStatus) {
    if (input.signatureStatus.confirmationStatus !== "finalized") return "submitted_pending";
    return input.signatureStatus.err === null ? "finalized_success" : "finalized_failure";
  }
  return input.currentBlockHeight > input.lastValidBlockHeight ? "expired" : "live";
}

export function assertSimulationSucceeded(value: unknown): void {
  if (!value || typeof value !== "object" || !("value" in value)) {
    throw new GasTankSponsorshipPolicyError("sponsored_simulation_unavailable");
  }
  const result = (value as { value?: unknown }).value;
  if (!result || typeof result !== "object" || !("err" in result)) {
    throw new GasTankSponsorshipPolicyError("sponsored_simulation_unavailable");
  }
  const simulation = result as { err: unknown; unitsConsumed?: unknown };
  if (simulation.err !== null) {
    throw new GasTankSponsorshipPolicyError("sponsored_simulation_failed");
  }
  if (
    typeof simulation.unitsConsumed === "number" &&
    (!Number.isSafeInteger(simulation.unitsConsumed) ||
      simulation.unitsConsumed < 0 ||
      simulation.unitsConsumed > MAX_SIMULATED_COMPUTE_UNITS)
  ) {
    throw new GasTankSponsorshipPolicyError("sponsored_compute_limit_exceeded");
  }
}


export const MAX_CONFIDENTIAL_ACCOUNT_SETUP_RENT_LAMPORTS = 10_000_000n;

const ASSOCIATED_TOKEN_PROGRAM_ADDRESS = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsJJA8knL";
const SYSTEM_PROGRAM_ADDRESS = "11111111111111111111111111111111";
const INSTRUCTIONS_SYSVAR_ADDRESS = "Sysvar1nstructions1111111111111111111111111";
const MEMO_PROGRAM_ADDRESS = "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr";
const SETUP_AUTHORIZATION_MEMO = new TextEncoder().encode(
  "Paylore confidential-account setup authorization"
);
const ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS = "ZkE1Gama1Proof11111111111111111111111111111";

type DecodedSetupMessage = {
  version: number | string;
  staticAccounts: readonly string[];
  header: {
    numSignerAccounts: number;
    numReadonlySignerAccounts: number;
    numReadonlyNonSignerAccounts: number;
  };
  instructions: readonly {
    programAddressIndex: number;
    accountIndices: readonly number[];
    data: Uint8Array;
  }[];
  addressTableLookups?: readonly unknown[];
};

function compiledAccountRole(message: DecodedSetupMessage, index: number) {
  const { header, staticAccounts } = message;
  const signer = index < header.numSignerAccounts;
  const writable = signer
    ? index < header.numSignerAccounts - header.numReadonlySignerAccounts
    : index < staticAccounts.length - header.numReadonlyNonSignerAccounts;
  return { signer, writable };
}

/**
 * Accepts only a narrow Token-2022 confidential-account initialization plan.
 * The transaction's owner signature and fee payer are verified separately by the relay.
 */
export function assertAllowedConfidentialAccountSetupMessage(input: {
  message: DecodedSetupMessage;
  feePayerAddress: string;
  ownerAddress: string;
  mintAddress: string;
  tokenAccountAddress: string;
  token2022ProgramAddress: string;
}): { reservedRentLamports: bigint } {
  const { message } = input;
  if (
    message.version !== 0 ||
    message.addressTableLookups?.length ||
    message.instructions.length < 1 ||
    message.instructions.length > 12 ||
    message.staticAccounts[0] !== input.feePayerAddress
  ) {
    throw new GasTankSponsorshipPolicyError("confidential_setup_transaction_invalid");
  }

  const roleAt = (index: number) => compiledAccountRole(message, index);
  const addressAt = (index: number) => message.staticAccounts[index];
  const requireAccount = (
    index: number,
    expected: string,
    role?: "signer" | "writable"
  ) => {
    if (addressAt(index) !== expected) return false;
    const actual = roleAt(index);
    if (role === "signer" && !actual.signer) return false;
    if (role === "writable" && !actual.writable) return false;
    return true;
  };

  if (!roleAt(0).signer || !roleAt(0).writable) {
    throw new GasTankSponsorshipPolicyError("confidential_setup_fee_payer_denied");
  }
  if (!message.staticAccounts.some((account, index) =>
    account === input.ownerAddress && roleAt(index).signer
  )) {
    throw new GasTankSponsorshipPolicyError("confidential_setup_owner_signature_required");
  }

  let reservedRentLamports = 0n;
  let systemRentLamports = 0n;
  let hasActionableSetupInstruction = false;
  let hasAssociatedTokenCreation = false;
  const addressDecoder = getAddressDecoder();

  for (const instruction of message.instructions) {
    if (!Number.isInteger(instruction.programAddressIndex) ||
        instruction.programAddressIndex < 0 ||
        instruction.programAddressIndex >= message.staticAccounts.length ||
        !Array.isArray(instruction.accountIndices) ||
        !(instruction.data instanceof Uint8Array)) {
      throw new GasTankSponsorshipPolicyError("confidential_setup_instruction_invalid");
    }
    const programAddress = addressAt(instruction.programAddressIndex);
    const accounts = instruction.accountIndices;
    const data = instruction.data;

    if (programAddress === MEMO_PROGRAM_ADDRESS) {
      if (accounts.length !== 1 ||
          !requireAccount(accounts[0], input.ownerAddress, "signer") ||
          data.length !== SETUP_AUTHORIZATION_MEMO.length ||
          !data.every((byte, index) => byte === SETUP_AUTHORIZATION_MEMO[index])) {
        throw new GasTankSponsorshipPolicyError("confidential_setup_memo_instruction_denied");
      }
      continue;
    }

    if (programAddress === ASSOCIATED_TOKEN_PROGRAM_ADDRESS) {
      const validData = data.length === 0 || (data.length === 1 && data[0] === 1);
      if (!validData || accounts.length !== 6 ||
          !requireAccount(accounts[0], input.feePayerAddress, "signer") ||
          !requireAccount(accounts[0], input.feePayerAddress, "writable") ||
          !requireAccount(accounts[1], input.tokenAccountAddress, "writable") ||
          !requireAccount(accounts[2], input.ownerAddress) ||
          !requireAccount(accounts[3], input.mintAddress) ||
          !requireAccount(accounts[4], SYSTEM_PROGRAM_ADDRESS) ||
          !requireAccount(accounts[5], input.token2022ProgramAddress)) {
        throw new GasTankSponsorshipPolicyError("confidential_setup_ata_instruction_denied");
      }
      hasAssociatedTokenCreation = true;
      hasActionableSetupInstruction = true;
      reservedRentLamports = MAX_CONFIDENTIAL_ACCOUNT_SETUP_RENT_LAMPORTS;
      continue;
    }

    if (programAddress === input.token2022ProgramAddress) {
      if (data.length === 1 && data[0] === 22 &&
          accounts.length === 1 &&
          requireAccount(accounts[0], input.tokenAccountAddress, "writable")) {
        continue;
      }
      if (data.length >= 3 && data.length <= 128 &&
          data[0] === 27 && data[1] === 2 &&
          accounts.length === 4 &&
          requireAccount(accounts[0], input.tokenAccountAddress, "writable") &&
          requireAccount(accounts[1], input.mintAddress) &&
          requireAccount(accounts[2], INSTRUCTIONS_SYSVAR_ADDRESS) &&
          requireAccount(accounts[3], input.ownerAddress, "signer")) {
        hasActionableSetupInstruction = true;
        continue;
      }
      throw new GasTankSponsorshipPolicyError("confidential_setup_token_instruction_denied");
    }

    if (programAddress === SYSTEM_PROGRAM_ADDRESS) {
      const dataView = new DataView(data.buffer, data.byteOffset, data.byteLength);
      if (data.length !== 52 || dataView.getUint32(0, true) !== 0 ||
          accounts.length !== 2 ||
          !requireAccount(accounts[0], input.feePayerAddress, "signer") ||
          !requireAccount(accounts[0], input.feePayerAddress, "writable") ||
          !addressAt(accounts[1]) ||
          !roleAt(accounts[1]).signer ||
          !roleAt(accounts[1]).writable) {
        throw new GasTankSponsorshipPolicyError("confidential_setup_system_instruction_denied");
      }
      const lamports = dataView.getBigUint64(4, true);
      const space = dataView.getBigUint64(12, true);
      const createdOwner = addressDecoder.decode(data.subarray(20, 52));
      if (createdOwner !== ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS ||
          lamports <= 0n || lamports > MAX_CONFIDENTIAL_ACCOUNT_SETUP_RENT_LAMPORTS ||
          space <= 0n || space > 4096n ||
          addressAt(accounts[1]) === input.ownerAddress) {
        throw new GasTankSponsorshipPolicyError("confidential_setup_proof_account_denied");
      }
      systemRentLamports += lamports;
      if (systemRentLamports > MAX_CONFIDENTIAL_ACCOUNT_SETUP_RENT_LAMPORTS) {
        throw new GasTankSponsorshipPolicyError("confidential_setup_rent_limit_exceeded");
      }
      if (!hasAssociatedTokenCreation) reservedRentLamports = systemRentLamports;
      hasActionableSetupInstruction = true;
      continue;
    }

    if (programAddress === ZK_ELGAMAL_PROOF_PROGRAM_ADDRESS) {
      if ((data[0] === 1 || data[0] === 4) && data.length > 1 &&
          accounts.length <= 3 &&
          accounts.every((index) => typeof addressAt(index) === "string") &&
          !accounts.some((index) => {
            const account = addressAt(index);
            return account === input.ownerAddress && !roleAt(index).signer;
          })) {
        continue;
      }
      throw new GasTankSponsorshipPolicyError("confidential_setup_proof_instruction_denied");
    }

    throw new GasTankSponsorshipPolicyError("confidential_setup_program_denied");
  }

  if (!hasActionableSetupInstruction) {
    throw new GasTankSponsorshipPolicyError("confidential_setup_instruction_missing");
  }
  if (hasAssociatedTokenCreation && systemRentLamports > 2_000_000n) {
    throw new GasTankSponsorshipPolicyError("confidential_setup_rent_limit_exceeded");
  }
  if (systemRentLamports > 0n && !hasAssociatedTokenCreation) {
    reservedRentLamports = systemRentLamports;
  }
  return { reservedRentLamports };
}
