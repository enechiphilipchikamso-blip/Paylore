export type GasTankSponsorshipAttempt = {
  status: "failed";
  transactionSignature: string;
  feeLamports: string;
  failureCode: "finalized_chain_failure";
  recordedAt: string;
};

type ExistingSponsorshipOperation = {
  status: string;
  transactionSignature: string | null;
  feeLamports: string | null;
  failureCode: string | null;
  updatedAt: Date;
  operationData: unknown;
};

type SponsorshipBudgetRow = {
  status: string;
  feeLamports: string | null;
  failureCode: string | null;
  operationData: unknown;
};

const LAMPORTS_PATTERN = /^(0|[1-9][0-9]*)$/;

function readLamports(value: unknown): bigint | null {
  if (typeof value !== "string" || !LAMPORTS_PATTERN.test(value)) return null;
  return BigInt(value);
}

function dataRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** Keep fee-bearing failures when retries reuse their idempotency row. */
export function readGasTankSponsorshipAttempts(operationData: unknown): GasTankSponsorshipAttempt[] {
  const history = dataRecord(operationData).sponsorshipAttempts;
  if (history === undefined) return [];
  if (!Array.isArray(history)) throw new Error("Invalid persisted Gas Tank sponsorship attempt history.");

  return history.map((value) => {
    if (!value || typeof value !== "object") {
      throw new Error("Invalid persisted Gas Tank sponsorship attempt history.");
    }
    const item = value as Record<string, unknown>;
    if (
      item.status !== "failed" ||
      item.failureCode !== "finalized_chain_failure" ||
      typeof item.transactionSignature !== "string" ||
      item.transactionSignature.length < 1 ||
      typeof item.feeLamports !== "string" ||
      readLamports(item.feeLamports) === null ||
      typeof item.recordedAt !== "string" ||
      !Number.isFinite(Date.parse(item.recordedAt))
    ) {
      throw new Error("Invalid persisted Gas Tank sponsorship attempt history.");
    }
    return {
      status: "failed",
      transactionSignature: item.transactionSignature,
      feeLamports: item.feeLamports,
      failureCode: "finalized_chain_failure",
      recordedAt: item.recordedAt
    };
  });
}

export function operationDataForGasTankRetry(input: {
  nextOperationData?: Record<string, unknown>;
  previousOperation: ExistingSponsorshipOperation;
  since: Date;
}): Record<string, unknown> {
  const history = readGasTankSponsorshipAttempts(input.previousOperation.operationData)
    .filter((attempt) => Date.parse(attempt.recordedAt) >= input.since.getTime());

  const previous = input.previousOperation;
  if (previous.status === "failed" && previous.failureCode === "finalized_chain_failure") {
    const fee = readLamports(previous.feeLamports);
    if (
      !previous.transactionSignature ||
      fee === null ||
      !Number.isFinite(previous.updatedAt.getTime())
    ) {
      throw new Error("Finalized sponsorship failure is missing durable fee evidence.");
    }
    if (previous.updatedAt.getTime() >= input.since.getTime()) {
      history.push({
        status: "failed",
        transactionSignature: previous.transactionSignature,
        feeLamports: String(fee),
        failureCode: "finalized_chain_failure",
        recordedAt: previous.updatedAt.toISOString()
      });
    }
  }

  return {
    ...(input.nextOperationData ?? {}),
    sponsorshipAttempts: history
  };
}

/** Budget accounting includes on-chain fees from failed attempts preserved across safe retries. */
export function summarizeGasTankSponsorshipBudget(input: {
  rows: SponsorshipBudgetRow[];
  reservedFeeLamports: string;
  since: Date;
}) {
  const reservedFee = readLamports(input.reservedFeeLamports);
  if (reservedFee === null || !Number.isFinite(input.since.getTime())) {
    throw new Error("Invalid Gas Tank sponsorship budget evidence.");
  }

  let feeLamports = 0n;
  let operationCount = 0;
  let reservedFeesLamports = 0n;
  for (const row of input.rows) {
    for (const attempt of readGasTankSponsorshipAttempts(row.operationData)) {
      if (Date.parse(attempt.recordedAt) < input.since.getTime()) continue;
      const fee = readLamports(attempt.feeLamports);
      if (fee === null) throw new Error("Persisted Gas Tank fee evidence is invalid.");
      feeLamports += fee;
      operationCount += 1;
    }

    const billable = ["preparing", "prepared", "finalized"].includes(row.status) ||
      (row.status === "failed" && row.failureCode === "finalized_chain_failure");
    if (!billable) continue;

    const data = dataRecord(row.operationData);
    const hasReserveFeeHistory = Array.isArray(data.feeReservationKeys) ||
      data.actualFeeLamports !== undefined ||
      data.feeBudgetReserved !== undefined;
    if (
      !hasReserveFeeHistory &&
      (data.stage === "wrap_pending" || data.stage === "wrap_verified")
    ) continue;

    let fee = readLamports(row.feeLamports);
    if (hasReserveFeeHistory && fee === null) {
      throw new Error("Persisted Gas Tank Reserve fee evidence is invalid.");
    }
    if (fee === null && (row.status === "preparing" || row.status === "prepared")) {
      fee = reservedFee;
    }
    if (fee === null) {
      throw new Error("Persisted Gas Tank operation is missing valid fee evidence.");
    }
    if (hasReserveFeeHistory) {
      const actualFee = data.actualFeeLamports === undefined
        ? 0n
        : readLamports(data.actualFeeLamports);
      const keys = Array.isArray(data.feeReservationKeys) ? data.feeReservationKeys : [];
      if (
        actualFee === null ||
        keys.some((key) => typeof key !== "string") ||
        new Set(keys).size !== keys.length
      ) throw new Error("Persisted Gas Tank Reserve fee evidence is invalid.");
      const reservedFee = data.feeBudgetReserved === true ? fee : 0n;
      const recordedReserved = data.reservedFeeBudgetLamports === undefined
        ? reservedFee
        : readLamports(data.reservedFeeBudgetLamports);
      if (
        recordedReserved === null ||
        recordedReserved !== reservedFee ||
        (!data.feeBudgetReserved && fee !== actualFee)
      ) throw new Error("Persisted Gas Tank Reserve fee reservation is invalid.");
      feeLamports += actualFee + reservedFee;
      const unreservedCount = typeof data.unreservedFeeOperationCount === "number" &&
        Number.isSafeInteger(data.unreservedFeeOperationCount) &&
        data.unreservedFeeOperationCount >= 0
        ? data.unreservedFeeOperationCount
        : 0;
      operationCount += keys.length + unreservedCount;
      if (row.status === "preparing" || row.status === "prepared") {
        reservedFeesLamports += reservedFee;
      }
    } else {
      operationCount += 1;
      feeLamports += fee;
      if (row.status === "preparing" || row.status === "prepared") {
        reservedFeesLamports += fee;
      }
    }
  }

  return {
    feeLamports,
    operationCount,
    reservedFeesLamports,
    overflow: input.rows.length > 1000
  };
}


/** Counts only rent held by active setup reservations; finalized rent is reflected in the live balance. */
export function sumPreparedSponsoredRentReservations(
  rows: Array<{ status: string; operationData: unknown }>
): bigint {
  let reserved = 0n;
  for (const row of rows) {
    if (row.status !== "preparing" && row.status !== "prepared") continue;
    const data = dataRecord(row.operationData);
    if (data.reservedRentLamports === undefined) continue;
    const amount = readLamports(data.reservedRentLamports);
    if (amount === null) throw new Error("Persisted Gas Tank rent reservation is invalid.");
    reserved += amount;
  }
  return reserved;
}
