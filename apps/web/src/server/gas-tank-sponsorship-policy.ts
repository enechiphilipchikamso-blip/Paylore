import {
  AccountRole,
  type Address
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
  claimAddress: string;
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
  expectedSigner: boolean
): boolean {
  if (!actual || typeof actual !== "object") return false;
  const account = actual as { address?: unknown; role?: unknown };
  const signer =
    account.role === AccountRole.WRITABLE_SIGNER ||
    account.role === AccountRole.READONLY_SIGNER;
  return account.address === expectedAddress && signer === expectedSigner;
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
    if (!claim.contributorAddress || !claim.claimAddress) {
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
    !expectInstructionAccount(init.accounts[0], input.authorityAddress, true) ||
    !expectInstructionAccount(init.accounts[1], input.workspaceAddress, false) ||
    !expectInstructionAccount(init.accounts[2], input.systemProgramAddress, false)
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
      !expectInstructionAccount(instruction.accounts[0], input.authorityAddress, true) ||
      !expectInstructionAccount(instruction.accounts[1], claim.contributorAddress, false) ||
      !expectInstructionAccount(instruction.accounts[2], input.workspaceAddress, false) ||
      !expectInstructionAccount(instruction.accounts[3], claim.claimAddress, false) ||
      !expectInstructionAccount(instruction.accounts[4], input.systemProgramAddress, false)
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
